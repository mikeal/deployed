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
  , net = require('net')
  ;

var portrange = 45032

function getPort (cb) {
  var port = portrange
  portrange += 1

  var server = net.createServer()
  server.listen(port, function (err) {
    server.once('close', function () {
      cb(port)
    })
    server.close()
  })
  server.on('error', function (err) {
    getPort(cb)
  })
}

function Child (proc, rev, cb) {
  var self = this
  self.process = proc
  self.rev = rev
  self.workdir = path.join(self.process.branch.deployment.workdir, uuid())
  
  getPort(function (port) {
    self.port = port
    
    function spawn (cb) {
      self.child = childprocess.spawn('node', [path.resolve(self.workdir, self.process.name), '--deployCtrlPort='+self.port])
      self.child.stdout.pipe(process.stdout)
      self.child.stderr.pipe(process.stderr) 
      self.child.on('exit', function () {
        // TODO: Add handling for possible infinite restart loops
        if (!self.closed) {
          self.process.branch.deployment.logger.error("["+self.process.name+"] processes exited, restarting!")
          spawn(function () {})
        } else {
          self.exited = true
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
            self.up = upnode.connect(self.port, function (remote) {
              self.remote = remote
              cb(null)
            })
          }, 1 * 1000)
        })
      })
    })
    
  })
}
Child.prototype.close = function () {
  var self = this
    , child = self.child
    ;
  self.closed = true
  self.remote.close(function (err) {
    if (err) return self.process.branch.deployment.logger.error('['+self.process.name+'] child reports close error at rev '+self.rev, err.message)
    self.process.branch.deployment.logger.log("["+self.process.name+"] child reports close at "+self.rev)
  })
  setTimeout(function () {
    if (!self.exited) {
      self.process.branch.deployment.logger.log("["+self.process.name+"] child requires hard kill at "+self.rev)
      child.kill('SIGKILL')
    }
  }, 10 * 1000) // one minute hard timeout on all child processes
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
    
    var child = new Child(self, rev, function (e) {
      if (e) throw e
      if (info.domains) {
        
        getPort(function (port) {
          child.httpPort = port
          // set info and rev, there is a bug, this will be HEAD on startup
          child.remote.setInfo({process:info, rev:child.rev})
          child.remote.startHttpServer(child.httpPort, function (err) {
            self.branch.deployment.logger.error('http server running', err)
            if (err) throw err
            if (oldchild) oldchild.close()
            self.child = child
            self.branch.deployment.logger.log('info', info)
            if (info.domains) {
              self.branch.deployment.logger.error('domains')
              self.branch.deployment.logger.error(info.domains)
              info.domains.forEach(function (domain) {
                if (!self.branch.deployment.routing[domain]) self.branch.deployment.routing[domain] = {}
                self.branch.deployment.routing[domain][self.branch.name] = [child.httpPort]
              })
              self.currentInfo = info 
              self.rolling = false
              if (self.nextRoll) self.nextRoll()
            }
          })
        })
      } else {
        if (oldchild) oldchild.close()
        self.child = child
        self.rolling = false
        if (self.nextRoll) self.nextRoll()
      }
    })
    self.branch.deployment.logger.log('['+self.name+'] creating child at rev '+child.rev)
    
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
  self.deployment.logger.log('update')
  fs.readFile(path.join(self.deployment.repo, 'package.json'), function (err, data) {
    if (err) throw err
    self.deployment.logger.log('got package')
    var pkg = JSON.parse(data.toString())
    self.deployment.logger.log('[branch] name ='+self.name)
    self.deployment.logger.log('[branch] pkg.deply = '+pkg.deploy[self.name])
    _.each(pkg.deploy[self.name], function (pinfo, process) {
      self.deployment.logger.log('[branch] rolling, '+self.name)
      self.process(process).roll(update.arguments[2], pinfo)
    }) 
  })
}

function Deployment (repo, logger) {
  var self = this
  self.repo = repo
  self.routing = {}
  self.branches = {}
  self.logger = logger || console
  self.workdir = process.cwd()
  self.pusher = pushover(path.dirname(repo), {checkout:true})
  self.pusher.autoCreate = false
  self.git = gitemit(path.join(repo, '.git'))
  self.git.on('update', function (update) {
    self.onUpdate(update)
  })
  fs.readFile(path.join(self.repo, 'package.json'), function (err, data) {
    var pkg = JSON.parse(data.toString())
    
    procstreams('git rev-parse HEAD', {cwd:self.repo})
    .data(function(stdout, stderr) {
      var rev = stdout.slice(0, stdout.length - 1)
      self.logger.error('starting with rev: '+JSON.stringify(rev))
      _.each(pkg.deploy, function (binfo, branch) {
        _.each(binfo, function (pinfo, process) {
          self.branch(branch).process(process).roll(rev, pinfo)
        })
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
    self.logger.log("Not a head push, skipping")
    update.accept()
    return
  }
  update.accept()
  setTimeout(function () {
    // This needs to get updated to something that makes sure the change applied
    procstreams('git reset --hard', {cwd:self.repo})
    .data(function(stdout, stderr) {
      self.branch(update.arguments[0].slice('refs/heads/'.length)).update(update)
    })
  }, 1000)
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

Deployment.prototype.balance = function (port) {
  var self = this
  bouncy(function (req, bounce) {
    var host = req.headers.host
    self.logger.log('Request: '+req.url+' '+host)
    if (!host) return self.logger.error('Request has no host header. '+req.url)
    if (self.routing[host]) return bounce.apply(bounce, self.routing[host].master)
    if (!host.indexOf('.')) return noroute(bounce)
    
    var subdomain = host.slice(0, host.indexOf('.'))
    var hostdomain = host.slice(host.indexOf('.')+1)
    
    if (!self.routing[hostdomain]) return noroute(bounce)
    if (subdomain === 'www') return bounce.apply(bounce, self.routing[hostdomain].master)
    if (!self.routing[hostdomain][subdomain]) return noroute(bounce)
    bounce.apply(bounce, self.routing[hostdomain][subdomain])
    
  }).listen(port);
}

module.exports = function (repo, logger) {
  return new Deployment(repo, logger)
}

var service = new events.EventEmitter()

// HACK!
for (i in service) {
  (function (i) {
    if (typeof service[i] !== 'function') return
    module.exports[i] = function () {
      service[i].apply(service, arguments)
    }
  })(i)
}

var logger = console

module.exports.logger = function (l) {
  logger = l
}

function control (port) {  
  
  process.on('uncaughtException', function(err) {
    logger.error('uncaughtException', err.stack, err)
    service.close(function () {})
  })
  
  service.startHttpServer = function (port, cb) {
    
    if (!module.exports.http && !module.exports.httpServer) return cb(new Error('deploy.http is not defined.'))
    module.exports.httpPort = port
    if (!module.exports.httpServer) {
      module.exports.httpServer = http.createServer(module.exports.http)
    }
    logger.info('process http port', port)
    module.exports.httpServer.listen(port, cb)
    service.emit('startHttpServer')
    service.once('shutdown', function () {
      module.exports.httpServer.close()
    })
  }
  service.info = function (cb) {
    cb(null, {port:port, httpPort:module.exports.httpPort, env:process.env, info:module.exports.info})
  }
  service.setInfo = function (info, cb) {
    module.exports.info = info
    service.emit('setInfo', info)
    if (cb) cb()
  }
  service.close = function (cb) {
    cb()
    service.emit('close')
    service.emit('shutdown')
  }
  
  var server = dnode(service)
  server.use(upnode.ping)
  logger.info('process control port', port)
  server.listen(port, function () {
    console.log("Deploy Control is up on port "+port+'.')
  })
  service.once('shutdown', function () {
    server.close()
    if (module.exports.close) {
      module.exports.close()
    }
  })
}

process.argv.forEach(function (arg) {
  if (arg.slice(0, '--deployCtrlPort='.length) === '--deployCtrlPort=') {
    control(arg.slice('--deployCtrlPort='.length))
  }
})

