var pushover = require('pushover')
  , replicant = require('replicant')
  , gitemit = require('git-emit')
  , path = require('path')
  , gits = {}
  , repos = pushover(path.join(__dirname, tests))
  ;

// repos.autoCreate = false
repos.on('push', function (repo) {
    
});

repos.list(function (err, reps) {
  reps.forEach(function (r) {
    gits[r] = gitemit(path.join(__dirname, r))
    gits[r].on('update', function (update) {
      console.log(update)
      update.reject('test')
    })
  })
})


repos.listen(7000);

