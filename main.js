var pushover = require('pushover')
  , replicant = require('replicant')
  , gitemit = require('git-emit')
  , path = require('path')
  , gits = {}
  , repos = pushover(path.join(__dirname, 'test'))
  ;

repos.autoCreate = false
repos.on('push', function (repo) {
    console.log('asdf')
});

repos.list(function (err, reps) {
  reps.forEach(function (r) {
    gits[r] = gitemit(path.join(repos.repoDir, r))
    gits[r].on('update', function (update) {
      console.log('update', update)
      update.reject('test')
    })
  })
})


repos.listen(7000);

