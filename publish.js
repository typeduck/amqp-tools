#!/usr/bin/env node

const Promise = require('bluebird')
const AMQP = require('amqplib')
const parseSpecs = require('./parseSpecs')
const cliArgs = require('command-line-args')
const cliOptions = [{
  name: 'url',
  alias: 'u',
  type: String,
  defaultValue: 'amqp://guest:guest@localhost',
  description: 'URL of AMQP server'
}, {
  name: 'nometa',
  alias: 'n',
  type: Boolean,
  defaultValue: false,
  description: 'ignore metadata when publishing (requires specs)'
}, {
  name: 'queue',
  alias: 'q',
  type: Boolean,
  defaultValue: false,
  description: 'use queue -- not exchange/route -- from metadata'
}, {
  name: 'verbose',
  alias: 'v',
  type: Boolean,
  defaultValue: false,
  description: 'turn volume up to 11'
}, {
  name: 'help',
  alias: 'h',
  type: Boolean,
  defaultValue: false,
  description: 'show help'
}]

let opts = cliArgs(cliOptions, {partial: true})
if (opts.help) {
  const cliUsage = require('command-line-usage')
  console.error(cliUsage([{
    header: 'amqp-publish',
    content: `\
Publish JSON-based AMQP messages from STDIN (see amqp-consume)
By default, published to original exchange+route from metadata, \
and additionally to specified queues or exchange+route`
  }, {
    header: 'Usage',
    content: 'amqp-publish [options] [specification...]'
  }, {
    header: 'Specification',
    content: `\
  specification := queue|binding
  binding       := exchange "/" route ("/" route)*`
  }, {
    header: 'Options',
    optionList: cliOptions
  }, {
    header: 'Examples',
    content: `\
$ amqp-publish < saved-messages.json

Publish the saved messages to the exchange as they were consumed from, using \
the same routing key.

$ amqp-publish -n amq.topic/my.topic.routing.key < saved-messages.json

Ignore original message metadata, instead publish to exchange 'amq.topic' \
with routing key 'my.topic.routing.key'.

$ amqp-publish -q < saved-messages.json

Publish the saved messages directly to the same queue they were consumed from.

$ amqp-publish amq.topic/route.one/route.two < saved-messages.json

Publish the saved messages to original exchange+route, but additionally to \
exchange 'amq.topic' using both 'route.one' and 'route.two' routing keys.
`
  }]))
  process.exit()
}
let specs = parseSpecs(opts._unknown || [])
let cliRoutes = specs.bindings.concat(specs.queues.map(function (q) {
  return { exchange: '', routingKey: q }
}))

let connection
let publisher

function exit (err) {
  console.error(err.message)
  process.exit(1)
}

Promise.try(function () {
  return AMQP.connect(opts.url)
}).then(function (conn) {
  connection = conn.on('error', exit)
  return connection.createConfirmChannel()
}).then(function (ch) {
  publisher = Promise.promisifyAll(ch)
  publisher.on('error', exit)
}).then(function () {
  readAndPublish()
}).catch(exit)

// Two ways of reading:
// - first char is "[", then read ALL data, publish after
// - first char is "{", stream newline-separated JSON objects
function readAndPublish () {
  let readMode = null
  function setReadMode (s) {
    if (readMode == null) { readMode = s.charAt(0) }
    process.stdin.removeListener('data', setReadMode)
    if (readMode !== '[' && readMode !== '{') {
      exit(new Error('Incorrect usage, try using --help'))
    }
  }
  // Buffer for unprocessed data
  let sBuffer = ''
  function readData (s) {
    sBuffer += s
    // react now if we are streaming
    if (readMode === '{') {
      let lines = sBuffer.split(/\r\n|\n|\r/)
      sBuffer = lines.pop()
      for (let line of lines) {
        publish(JSON.parse(line))
      }
    }
  }
  function doPublish () {
    if (sBuffer) { publish(JSON.parse(sBuffer)) }
  }
  if (opts.verbose) {
    console.error('Reading JSON from STDIN')
  }
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', setReadMode)
  process.stdin.on('data', readData)
  process.stdin.on('end', doPublish)
  process.stdin.on('end', startQuitting)
}

let waitingForConfirm = 0
let waitingForData = true
let interruptsReceived = 0

function startQuitting () {
  waitingForData = false
  checkForQuit()
}

function handleInterrupt () {
  interruptsReceived += 1
  if (!process.stdin.isPaused()) { process.stdin.pause() }
  startQuitting()
}

process.on('SIGINT', handleInterrupt)
process.on('SIGTERM', handleInterrupt)

function publish (obj) {
  if (Array.isArray(obj)) { return obj.forEach(publish) }
  let hasMetadata = obj.fields && obj.properties && obj.content
  let routes = cliRoutes.slice()
  if (hasMetadata && !opts.nometa) {
    routes.push({
      exchange: opts.queue ? '' : obj.fields.exchange,
      routingKey: opts.queue ? obj.queue : obj.fields.routingKey
    })
  }
  let content = hasMetadata ? obj.content : obj
  let buff = new Buffer(JSON.stringify(content))
  waitingForConfirm += 1
  return Promise.map(routes, function (r) {
    return publisher.publishAsync(r.exchange, r.routingKey, buff, {
      deliveryMode: (obj.properties && obj.properties.deliveryMode) || 1,
      contentType: 'application/json',
      contentEncoding: 'utf-8'
    })
  }).then(function () {
    waitingForConfirm -= 1
    checkForQuit()
  })
}

function checkForQuit () {
  if (interruptsReceived > 1) {
    console.error('[%s] Forced Quit', new Date())
    process.exit(1)
  }
  if (waitingForData) { return }
  if (waitingForConfirm) { return }
  Promise.try(function () {
    return publisher.close()
  }).then(function () {
    return connection.close()
  }).then(function () {
    if (opts.verbose) {
      console.error('[%s] B-Bye now!', new Date())
    }
  }).catch(exit)
}
