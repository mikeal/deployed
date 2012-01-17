var pushover = require('pushover')
  , gitemit = require('git-emit')
  , util = require('util')
  , net = require('net')
  , http = require('http')
  , events = require('events')
  , path = require('path')
  , fs = require('fs')
  , upnode = require('upnode')
  , _ = require('underscore')
  , procstreams = require('procstreams')
  , childprocess = require('child_process')
  , bouncy = require('bouncy')
  , dnode = require('dnode')
  , uuid = require('./uuid')
  ;

var portrange = 45032
  , httpportrange = 50032
  ;

function Child (proc, rev, cb) {
  var self = this
  self.process = proc
  self.rev = rev
  self.workdir = path.join(self.process.branch.deployment.workdir, uuid())
  self.port = portrange + 1
  portrange += 1
  
  function spawn (cb) {
    self.child = childprocess.spawn('node', [path.resolve(self.workdir, self.process.name), '--deployCtrlPort='+self.port])
    self.child.stdout.pipe(process.stdout)
    self.child.stderr.pipe(process.stderr) 
    self.child.on('exit', function () {
      // TODO: Add handling for possible infinite restart loops
      if (!self.closed) {
        console.error("processes exited, restarting!")
        spawn(function () {})
      }
    })
    cb()
  }
  
  fs.mkdir(self.workdir, 0755, function (e) {
    if (e) return cb(e)
    procstreams('git archive --format=tar '+rev, {cwd:self.process.branch.deployment.repo})
    .pipe('tar -x', {cwd:self.workdir})
    .on('exit', function (status) {
      spawn(function () {
        setTimeout(function () {
          console.log('moar!')
          self.up = upnode.connect(self.port, function (remote) {
            self.remote = remote
            cb(null)
          })
        }, 1 * 1000)
      })
    })
  })
}
Child.prototype.close = function () {
  var self = this
  self.closed = true
  self.remote.close(function (err) {
    if (err) return console.error('child reports close error', err.message)
    console.log("child reports close.")
  })
  setTimeout(function () {
    self.child.kill('SIGKILL')
  }, 60 * 1000) // one minute hard timeout on all child processes
}
// util.inherits(Child, events.EventEmitter)

function Process (branch, name) {
  this.branch = branch
  this.name = name
  this.rolling = false
}
Process.prototype.roll = function (rev, info) {
  var self = this
  self.nextRoll = function () {
    self.nextRoll = null
    self.rolling = true
    // Process rolling logic goes here.
    // var num = info.processes
    //   , newprocs = []
    //   ;
    
    var oldchild = self.child
    console.log('creating child')
    self.child = new Child(self, rev, function (e) {
      if (e) throw e
      if (info.domains) {
        self.child.httpPort = httpportrange + 1
        httpportrange += 1
        // set info and rev, there is a bug, this will be HEAD on startup
        self.child.remote.setInfo({process:info, rev:rev})
        self.child.remote.startHttpServer(self.child.httpPort, function (err) {
          if (err) throw err
          if (oldchild) oldchild.close()
          console.log('info', info)
          if (info.domains) {
            info.domains.forEach(function (domain) {
              if (!self.branch.deployment.routing[domain]) self.branch.deployment.routing[domain] = {}
              self.branch.deployment.routing[domain][self.branch.name] = [self.child.httpPort]
            })
            self.currentInfo = info 
            self.rolling = false
            if (self.nextRoll) self.nextRoll()
          }
        })
      } else {
        if (oldchild) oldchild.close()
        self.rolling = false
        if (self.nextRoll) self.nextRoll()
      }
    })
    
    // function newproc (cb) {
    //   num = num - 1
    //   var child = new Child(self, rev)
    //   
    // }
    // 
    // newproc(function (e) {
    //   if (e) throw e
    //   while (num !== 0) {
    //     newproc()
    //   }
    // })
    
    
    
  }
  if (!this.rolling) self.nextRoll()
}

function Branch (deployment, name) {
  this.deployment = deployment
  this.name = name
  this.processes = {}
}
Branch.prototype.process = function (name) {
  if (!this.process[name]) this.process[name] = new Process(this, name)
  return this.process[name]
}
Branch.prototype.update = function (update) {
  var self = this
  console.log('update')
  fs.readFile(path.join(self.deployment.repo, 'package.json'), function (err, data) {
    if (err) throw err
    console.log('got package')
    var pkg = JSON.parse(data.toString())
    console.log(self.name)
    console.log(pkg.deploy[self.name])
    _.each(pkg.deploy[self.name], function (pinfo, process) {
      console.log('rolling')
      self.process(process).roll(update.arguments[2], pinfo)
    }) 
  })
}

function Deployment (repo) {
  var self = this
  self.repo = repo
  self.routing = {}
  self.branches = {}
  self.workdir = process.cwd()
  self.pusher = pushover(path.dirname(repo), {checkout:true})
  self.pusher.autoCreate = false
  self.git = gitemit(path.join(repo, '.git'))
  self.git.on('update', function (update) {
    self.onUpdate(update)
  })
  fs.readFile(path.join(self.repo, 'package.json'), function (err, data) {
    var pkg = JSON.parse(data.toString())
    _.each(pkg.deploy, function (binfo, branch) {
      _.each(binfo, function (pinfo, process) {
        self.branch(branch).process(process).roll('HEAD', pinfo)
      })
    })
  })
  
}
Deployment.prototype.branch = function (name) {
  if (!this.branches[name]) this.branches[name] = new Branch(this, name)
  return this.branches[name]
} 

Deployment.prototype.onUpdate = function (update) {
  var self = this
  if (update.arguments[0].slice(0, 'refs/heads/'.length) !== 'refs/heads/') {
    console.log("Not a head push, skipping")
    update.accept()
    return
  }
  update.accept()
  self.branch(update.arguments[0].slice('refs/heads/'.length)).update(update)
}
Deployment.prototype.listen = function () {
  this.port = arguments[0]
  this.pusher.listen.apply(this.pusher, arguments)
}

function noroute (bounce) {
  var resp = bounce.respond()
  resp.statusCode = 400
  resp.end('No route for this host header.')
}

Deployment.prototype.balance = function () {
  var self = this
  bouncy(function (req, bounce) {
    var host = req.headers.host
    console.log(self.routing)
    if (!host) return console.error('Request has no host header.')
    if (self.routing[host]) return bounce.apply(bounce, self.routing[host].master)
    if (!host.indexOf('.')) return noroute(bounce)
    
    var subdomain = host.slice(0, host.indexOf('.'))
    var hostdomain = host.slice(host.indexOf('.')+1)
    
    if (!self.routing[hostdomain]) return noroute(bounce)
    if (subdomain === 'www') return bounce.apply(bounce, self.routing[host].master)
    if (!self.routing[hostdomain][subdomain]) return noroute(bounce)
    bounce.apply(bounce, self.routing[host][subdomain])
    
  }).listen(8000);
}

module.exports = function (repo) {
  return new Deployment(repo)
}

function control (port) {
  var service = {}
  service.startHttpServer = function (port, cb) {
    if (!module.exports.http) return cb(new Error('deploy.http is not defined.'))
    module.exports.httpPort = port
    module.exports.httpServer = http.createServer(module.exports.http)
    module.exports.httpServer.listen(port, cb)
  }
  service.info = function (cb) {
    cb(null, {port:port, httpPort:module.exports.httpPort, env:process.env, info:module.exports.info})
  }
  service.setInfo = function (info, cb) {
    module.exports.info = info
    if (cb) cb()
  }
  service.close = function (cb) {
    if (module.exports.httpServer) {
      module.exports.httpServer.close()
      if (module.exports.close) return module.exports.close(cb)
    } else if (module.exports.close) {
      return module.exports.close(cb)
    } else {
      cb()
      process.exit()
    }
  }
  
  var server = dnode(service)
  server.use(upnode.ping)
  server.listen(port, function () {
    console.log("Deploy Control is up on port "+port+'.')
  })
}

process.argv.forEach(function (arg) {
  if (arg.slice(0, '--deployCtrlPort='.length) === '--deployCtrlPort=') {
    control(arg.slice('--deployCtrlPort='.length))
  }
})

