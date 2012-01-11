var pushover = require('pushover')
  , replicant = require('replicant')
  , gitemit = require('git-emit')
  , util = require('util')
  , events = require('events')
  , path = require('path')
  , procstreams = require('procstreams')
  ;
  
function Deploy (config) {
  var example =
    { processes: 4
    , repo: '/repo/app'
    , rev: 'sadfh87ashdf87ashdf87ashdf'
    , workdir: '/deploys'
    }
  
  procstreams('mkdir '+path.join(config.workdir, config.rev))
  .and('git archive --format=tar '+config.rev, {cwd:config.rep})
  .pipe('tar -x', {cwd:path.join(config.workdir, config.rev)})
  .on('exit', function () {
    console.log('done')
  })
  
}  
util.inherits(Deploy, events.EventEmitter)

function Deployment (config) {
  var self = this
  for (i in config) {
    self[i] = config[i]
  }
  self.git = {}
}
Deployment.prototype.repos = function (dir) {
  var self = this
  self.pusher = pushover(dir)
  self.pusher.autoCreate = false
  self.pusher.list(function (err, repos) {
    if (err) throw err
    repos.forEach(function (r) {
      self.git[r] = gitemit(path.join(self.pushover.repoDir, r))
      self.git[r].on('update', function (update) {
        self.onUpdate(self.git[r], update)
      })
    })
  })
}
Deployment.prototype.onUpdate = function (git, update) {
  if (!arguments[0].slice(0, 'refs/heads/'.length) === 'refs/heads/') {
    console.log("Not a head push, skipping")
    update.accept()
    return
  }
  update.accept('test')
}
Deployment.prototype.listen = function () {
  this.pusher.listen.apply(this.pusher, arguments)
}

module.exports = function (opts) {
  if (!opts) opts = {}
  if (typeof opts === 'string') {
    opts = {name:opts}
  }
  return new Deployment(opts)
}

var d = new Deployment()
d.repos(path.join(__dirname, 'tests', 'repos'))
d.listen(7000)

