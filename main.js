var pushover = require('pushover')
  , replicant = require('replicant')
  , gitemit = require('git-emit')
  , util = require('util')
  , net = require('net')
  , events = require('events')
  , path = require('path')
  , fs = require('fs')
  , _ = require('underscore')
  , procstreams = require('procstreams')
  , childprocess = require('child_process')
  , bouncy = require('bouncy')
  ;
  
function deploy (config, cb) {
  var example =
      { processes: 4
      , repo: '/repo/app'
      , rev: 'sadfh87ashdf87ashdf87ashdf'
      , workdir: '/deploys'
      }
    , workdir = path.join(config.workdir, config.rev)
    ;
  
  procstreams('mkdir '+path.join(config.workdir, config.rev))
  .and('git archive --format=tar '+config.rev, {cwd:config.rep})
  .pipe('tar -x', {cwd:workdir})
  .on('exit', function () {
    fs.readFile(path.join(workdir, 'package.json'), function (err, data) {
      if (err) throw err
      var pkg = JSON.parse(data.toString())
      pkg.path = workdir 
      cb(null, pkg)
    })
  })
} 

var portrange = 45032
  , httpportrange = 50032
  ;

function Child (process, rev) {
  var self = this
  self.process = process
  self.rev = rev
  self.workdir = path.join(process.branch.deployment.workdir, uuid())
  self.port = portrange + 1
  portrange += 1
  fs.mkdir(self.workdir, function (e) {
    if (e) throw e
    procstreams('git archive --format=tar '+rev, {cwd:process.branch.deployment.repo})
    .pipe('tar -x', {cwd:self.workdir})
    .on('exit', function (status) {
      console.error(status)
      self.child = child_process.spawn('node', [path.resolve(self.workdir, self.process.name), '--deployCtrlPort='+self.port])
      setTimeout(function () {
        dnode.connect(self.port, function (remote) {
          self.remote = remote
          self.emit('running')
        })
      }, 1 * 1000)
    })
  })
}

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
    
    self.child = new Child(self, rev)
    self.child.on('running', function () {
      if (info.domain) {
        self.child.httpPort = httpportrange + 1
        httpportrange += 1
        self.child.remote.startHttpServer(self.child.httpPort, function (err) {
          if (err) throw err
          if (oldchild) oldchild.close()
          if (info.domains) {
            info.domains.forEach(function (domain) {
              self.branch.deployment.routing[domain][self.branch.name] = [self.child.httpPort]
            })
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

function Deployment (repo) {
  var self = this
  self.repo = repo
  self.routing = {}
  self.pusher = pushover(path.dirname(repo))
  self.pusher.autoCreate = false
  console.log(repo)
  self.git = gitemit(repo)
  self.git.on('update', function (update) {
    self.onUpdate(update)
  })
  fs.readFile(path.join(self.repo, 'package.json'), function (err, data) {
    var pkg = data.toString()
    
    _.each(pkg.deploy, function (binfo, branch) {
      _each(binfo, function (pinfo, process) {
        self.branch(branch).process(process).roll('HEAD', pinfo)
      })
    })
    
  })
  
  self.port = 43000
}

Deployment.prototype.onUpdate = function (update) {
  var self = this
  if (!update.arguments[0].slice(0, 'refs/heads/'.length) === 'refs/heads/') {
    console.log("Not a head push, skipping")
    update.accept()
    return
  }
  update.accept()
  self.branch(update.arguments[0].slice(0, 'refs/heads/'.length)).update(update)
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
  
  bouncy(function (req, bounce) {
    var host = req.headers.host
    
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
  service.heartbeat = function (cb) {
    cb(null, true)
  }
  service.startHttpServer = function (port, cb) {
    if (!module.exports.http) return cb(new Error('deploy.http is not defined.'))
    module.exports.httpPort = port
    http.createServer(module.exports.http).listen(port, cb)
  }
  service.info = function (cb) {
    cb(null, {port:port, httpPort:module.exports.httpPort, env:process.env})
  }
  
  dnode(service).listen(port, function () {
    console.log("Deploy Control is up on port "+port+'.')
  })
}

process.argv.forEach(function (arg) {
  if (arg.slice(0, '--deployCtrlPort='.length) === '--deployCtrlPort=') {
    control(arg.slice('--deployCtrlPort='.length))
  }
})

