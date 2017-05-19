#!/usr/bin/env node

const Moment = require('moment')
const assign = require('lodash.assign')
const omit = require('lodash.omit')
const Promise = require('bluebird')
const AMQP = require('amqplib')
const UUID = require('uuid')
const cliArgs = require('command-line-args')
const parseSpecs = require('./parseSpecs')
const rc = require('rc')

const cliOptions = [{
  name: 'url',
  alias: 'u',
  type: String,
  defaultValue: 'amqp://guest:guest@localhost',
  description: 'URL of AMQP server'
}, {
  name: 'max',
  alias: 'x',
  type: Number,
  defaultValue: Infinity,
  description: 'maximum messages to consume'
}, {
  name: 'min',
  type: Number,
  defaultValue: 0,
  description: 'require minimum messages available to consume'
}, {
  name: 'indentation',
  alias: 'i',
  type: Number,
  defaultValue: 0,
  description: 'JSON output indentation'
}, {
  name: 'ack',
  alias: 'a',
  type: Boolean,
  defaultValue: false,
  description: 'acknowledge consumed messages'
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

// this shim is due to how rc works
let defaults = {}
for (let o of cliOptions) {
  defaults[o.name] = o.defaultValue
  delete o.defaultValue
}

let opts = rc('amqp-tools', defaults, cliArgs(cliOptions, {partial: true}))
if (opts.help || !opts._unknown || !opts._unknown.length) {
  const cliUsage = require('command-line-usage')
  console.error(cliUsage([{
    header: 'amqp-consume',
    content: 'Consumes AMQP messages from Queues and Exchange+RoutingKey'
  }, {
    header: 'Usage',
    content: `amqp-consume [options] specification [specification...]

specification := queue|binding
binding       := exchange "/" route ("/" route)*`
  }, {
    header: 'Options',
    optionList: cliOptions
  }, {
    header: 'Output',
    content: `\
The output is a stream of JSON data, or an array of messages when indentation \
is used. The JSON data matches the output of amqplib, with some added friendly \
conversion of binary data and, when contentType is 'application/json', JSON \
parsing.`
  }, {
    header: 'Examples',
    content: `\
$ amqp-consume -x 10 -a my-queue

Consume and acknowledge 10 messages from queue named 'my-queue'.

$ amqp-consume amq.topic/# My-Exchange/my.routing.key my-queue

Consume all messages from exchange 'amq.topic', messages from exchange \
'My-Exchange' matching the routing key 'my.routing.key', and also messages from \
queue named 'my-queue'. (Stop consuming on interrupt.)
`
  }]))
  process.exit(1)
}
const specs = parseSpecs(opts._unknown)

let connection
let consumer
let consumerTags = []

function exit (err) {
  console.error(err.message)
  process.exit(1)
}

Promise.try(function createConnection () {
  if (opts.verbose) {
    const URL = require('url')
    let url = URL.format(omit(URL.parse(opts.url), 'auth'))
    console.error('[%s] Connecting to %s', new Date(), url)
  }
  return AMQP.connect(opts.url)
}).then(function createChannel (conn) {
  connection = conn.on('error', exit)
  return connection.createChannel()
}).then(function checkAllQueues (channel) {
  consumer = channel.on('error', exit)
  if (opts.max !== Infinity) {
    consumer.prefetch(opts.max, true)
  }
  return Promise.map(specs.queues, (q) => channel.checkQueue(q))
}).then(function checkMinimumMessages (info) {
  if (opts.min > 0) {
    if (specs.bindings.length > 0) {
      throw new Error('--min cannot be used for exchange bindings')
    }
    if (opts.min > opts.max) {
      throw new Error('--min cannot be greather than --max')
    }
    let availMessages = 0
    for (let q of info) { availMessages += q.messageCount }
    if (availMessages < opts.min) {
      throw new Error(`--min=${opts.min}, only ${availMessages}`)
    }
  }
}).then(function createDynamicBindings () {
  // Create the dynamic queue for subscriptions in bindSpecs
  if (!specs.bindings.length) { return null }
  return consumer.assertQueue('', {
    exclusive: true,
    autoDelete: true,
    durable: false,
    expires: 1000 * 60
  }).then(function (q) {
    if (opts.verbose) {
      console.error('[%s] Queue "%s" created', new Date(), q.queue)
    }
    specs.queues.push(q.queue)
    return Promise.map(specs.bindings, function bindOneSpec (spec) {
      return consumer.bindQueue(q.queue, spec.exchange, spec.routingKey)
    })
  })
}).then(function startConsuming () {
  // NOTE: somewhat unusual but we generate own consumerTags as message callback
  // may be called before subscription information is returned, which can cause
  // shutdown/cancellation before we have cTag info
  return Promise.map(specs.queues, function (q) {
    let consumeFunc = gotMessage.bind(null, q)
    let cTag = UUID.v4()
    consumerTags.push(cTag)
    return consumer.consume(q, consumeFunc, { consumerTag: cTag })
  })
}).then(function (subs) {
  if (opts.verbose) {
    console.error('[%s] Consuming started', new Date())
    for (let cTag of consumerTags) {
      console.error('[%s] consumerTag: %s', new Date(), cTag)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}).catch(exit)

// NOTE: there are two modes for outputting JSON. Default is "valid JSON file"
// mode, in which all objects are in a JSON array. If JSONSPACES=0, we go into
// "newline-separated" mode, which can be useful for streaming back into publish
// (which will automatically detect the mode based on first character being "{"
// or "["). The latter mode then always puts a newline following an object, the
// former mode writes the newline and comma prior to ouputting object.
let counter = 0
function gotMessage (qName, msg) {
  // Log the message, only if we haven't reached limit
  if (counter < opts.max) {
    if (counter === 0) {
      if (opts.indentation !== 0) { process.stdout.write('[\n ') }
    } else {
      if (opts.indentation !== 0) { process.stdout.write('\n,') }
    }
    // convert the object, write to stdout
    let obj = createJSON({date: Moment().toISOString(), queue: qName}, msg)
    process.stdout.write(JSON.stringify(obj, null, opts.indentation))
    if (opts.indentation === 0) { process.stdout.write('\n') }
  }
  // Increment counter
  counter += 1
  if (counter === opts.max) {
    return setImmediate(shutdown)
  } else if (opts.max === Infinity) {
    consumer.ack(msg)
  }
}

// Serializes message for JSON output
function createJSON (base, msg) {
  // Attach all message stuff sans content
  let ret = assign(base, omit(msg, 'content'))
  // Convert content into string
  let sContent = convertContent(msg.content, msg.properties)
  // Alter object content based on type
  let cType = msg.properties.contentType
  if (/^application\/json$/.test(cType)) {
    try {
      ret.content = JSON.parse(sContent)
    } catch (e) {
      ret.content = sContent
    }
  } else if (/^text\//.test(cType)) {
    ret.content = sContent
  } else {
    ret.content = sContent
    if (ret.properties.contentType == null) {
      ret.properties.contentType = 'application/octet-stream'
    }
  }
  return ret
}

// Converts Buffer to a string, altering contentEncoding as appropriate
function convertContent (buff, props) {
  let cEnc = (props && props.contentEncoding) || ''
  cEnc = cEnc.toLowerCase().replace(/[^a-z0-9]/g, '')
  // For JSON content without encoding, assume UTF-8
  if (!cEnc && /^application\/json/.test(props.contentType)) {
    props.contentEncoding = 'utf8'
    return buff.toString()
  }
  // Leave hex strings as HEX-viewable
  if (cEnc === 'hex') {
    props.contentEncoding = 'hex'
    return buff.toString('ascii')
  }
  // ASCII text can keep its encoding
  if (cEnc === 'ascii') {
    props.contentEncoding = 'ascii'
    return buff.toString('ascii')
  }
  if (cEnc === 'utf8') {
    props.contentEncoding = 'utf8'
    return buff.toString('utf8')
  }
  // Convert UCS-2, it will be output as UTF-8
  if (cEnc === 'utf16le' || cEnc === 'ucs2') {
    props.contentEncoding = 'utf8'
    return buff.toString(cEnc)
  }
  // Binary: convert to base64
  if (cEnc === 'binary') {
    props.contentEncoding = 'base64'
    return buff.toString('base64')
  }
  // Already base64: don't double-encode
  if (cEnc === 'base64') {
    props.contentEncoding = 'base64'
    return buff.toString('ascii')
  }
  // Leave a trace of other unknown encoding before base64
  props.contentEncoding = cEnc ? `base64,${cEnc}` : 'base64'
  return buff.toString('base64')
}

// Closes the connection
function shutdown () {
  process.removeListener('SIGINT', shutdown)
  process.removeListener('SIGTERM', shutdown)
  Promise.try(function cancelSubscriptions () {
    return Promise.map(consumerTags, (cTag) => consumer.cancel(cTag))
  }).then(function closeConnections () {
    if (opts.indentation !== 0 && counter) { process.stdout.write('\n]\n') }
    if (opts.ack) { consumer.ackAll() }
    // delay is to ensure ack is received
    return Promise.delay(100).then(function () {
      return consumer.close()
    }).then(function () {
      return connection.close()
    })
  }).catch(exit)
}
