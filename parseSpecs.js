'use strict'

module.exports = function parseSpecifications (specs) {
  const RX = {
    Binding: /^([^\/]+)((?:\/[^\/]+)+)$/,
    Route: /\/[^\/]+/g
  }
  const bindSpecs = []
  const queueNames = []
  for (let spec of specs) {
    let match = RX.Binding.exec(spec)
    if (match) {
      let routes = match[2].match(RX.Route)
      for (let route of routes) {
        bindSpecs.push({
          exchange: match[1],
          routingKey: route.slice(1)
        })
      }
    } else {
      queueNames.push(spec)
    }
  }
  return {
    queues: queueNames,
    bindings: bindSpecs
  }
}
