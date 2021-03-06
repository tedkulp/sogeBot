const _ = require('lodash')
const axios = require('axios')
const config = require('@config')

const __DEBUG__ = {
  STREAM: (process.env.DEBUG && process.env.DEBUG.includes('webhooks.stream'))
}

class Webhooks {
  constructor () {
    this.timeouts = {}

    this.enabled = {
      follows: false,
      streams: false
    }
    this.cache = []

    this.unsubscribe('follows').then(() => this.subscribe('follows'))
    this.unsubscribe('streams').then(() => this.subscribe('streams'))

    this.clearCache()
  }

  addIdToCache (type, id) {
    this.cache.push({
      id: id,
      type: type,
      timestamp: _.now()
    })
  }

  clearCache () {
    clearTimeout(this.timeouts['clearCache'])
    this.cache = _.filter(this.cache, (o) => o.timestamp >= _.now() - 600000)
    setTimeout(() => this.clearCache, 600000)
  }

  existsInCache (type, id) {
    return !_.isEmpty(_.find(this.cache, (o) => o.type === type && o.id === id))
  }

  async unsubscribe (type) {
    clearTimeout(this.timeouts[`unsubscribe-${type}`])

    const cid = global.oauth.channelId
    const clientId = await global.oauth.settings._.clientId
    if (cid === '' || clientId === '') {
      this.timeouts[`unsubscribe-${type}`] = setTimeout(() => this.subscribe(type), 1000)
      return
    }

    // get proper domain
    let domains = config.panel.domain.split(',').map((o) => o.trim()).filter((o) => o !== 'localhost')
    if (domains.length === 0) return
    let domain = domains[0]

    const mode = 'unsubscribe'
    const callback = `http://${domain}/webhooks/hub`

    const request = [
      'https://api.twitch.tv/helix/webhooks/hub?',
      `hub.mode=${mode}`,
      `hub.callback=${callback}/${type}`
    ]

    switch (type) {
      case 'follows':
        request.push(`hub.topic=https://api.twitch.tv/helix/users/follows?to_id=${cid}`)
        await axios({
          method: 'post',
          url: request.join('&'),
          headers: {
            'Client-ID': clientId
          }
        })
        break
      case 'streams':
        request.push(`hub.topic=https://api.twitch.tv/helix/streams?user_id=${cid}`)
        await axios({
          method: 'post',
          url: request.join('&'),
          headers: {
            'Client-ID': clientId
          }
        })
        break
    }
  }

  async subscribe (type, quiet) {
    clearTimeout(this.timeouts[`subscribe-${type}`])

    const cid = global.oauth.channelId
    const clientId = await global.oauth.settings._.clientId
    if (cid === '' || clientId === '') {
      this.timeouts[`subscribe-${type}`] = setTimeout(() => this.subscribe(type), 1000)
      return
    }

    // get proper domain
    let domains = config.panel.domain.split(',').map((o) => o.trim()).filter((o) => o !== 'localhost')
    if (domains.length === 0) return global.log.warning(`No suitable domain found to use with ${type} webhook ... localhost is not suitable`)
    let domain = domains[0]

    const leaseSeconds = 864000
    const mode = 'subscribe'
    const callback = `http://${domain}/webhooks/hub`

    const request = [
      'https://api.twitch.tv/helix/webhooks/hub?',
      `hub.mode=${mode}`,
      `hub.callback=${callback}/${type}`,
      `hub.lease_seconds=${leaseSeconds}`
    ]

    var res
    switch (type) {
      case 'follows':
        request.push(`hub.topic=https://api.twitch.tv/helix/users/follows?to_id=${cid}`)
        res = await axios({
          method: 'post',
          url: request.join('&'),
          headers: {
            'Client-ID': clientId
          }
        })
        if (res.status === 202 && res.statusText === 'Accepted') global.log.info('WEBHOOK: follows waiting for challenge')
        else global.log.error('WEBHOOK: follows NOT subscribed')
        break
      case 'streams':
        request.push(`hub.topic=https://api.twitch.tv/helix/streams?user_id=${cid}`)
        res = await axios({
          method: 'post',
          url: request.join('&'),
          headers: {
            'Client-ID': clientId
          }
        })
        if (res.status === 202 && res.statusText === 'Accepted') global.log.info('WEBHOOK: streams waiting for challenge')
        else global.log.error('WEBHOOK: streams NOT subscribed')
        break
      default:
        return // don't resubcribe if subscription is not correct
    }

    // resubscribe after while
    this.timeouts[`subscribe-${type}`] = setTimeout(() => this.subscriber(type), leaseSeconds * 1000)
  }

  async event (aEvent, res) {
    const cid = global.oauth.channelId

    // somehow stream doesn't have a topic
    if (_.get(aEvent, 'topic', null) === `https://api.twitch.tv/helix/users/follows?to_id=${cid}`) this.follower(aEvent) // follow
    else if (_.get(!_.isNil(aEvent.data[0]) ? aEvent.data[0] : {}, 'type', null) === 'live') this.stream(aEvent) // streams

    res.sendStatus(200)
  }

  async challenge (req, res) {
    const cid = global.oauth.channelId
    // set webhooks enabled
    switch (req.query['hub.topic']) {
      case `https://api.twitch.tv/helix/users/follows?to_id=${cid}`:
        global.log.info('WEBHOOK: follows subscribed')
        this.enabled.follows = true
        break
      case `https://api.twitch.tv/helix/streams?user_id=${cid}`:
        global.log.info('WEBHOOK: streams subscribed')
        this.enabled.streams = true
        break
    }
    res.send(req.query['hub.challenge'])
  }

  async follower (aEvent) {
    const cid = global.oauth.channelId
    if (_.isEmpty(cid)) setTimeout(() => this.follower(aEvent), 10) // wait until channelId is set
    if (parseInt(aEvent.data.to_id, 10) !== parseInt(cid, 10)) return
    const fid = aEvent.data.from_id

    // is in webhooks cache
    if (this.existsInCache('follow', aEvent.data.from_id)) return

    // add to cache
    this.addIdToCache('follow', aEvent.data.from_id)

    // check if user exists in db
    let user = await global.db.engine.findOne('users', { id: fid })
    if (_.isEmpty(user)) {
      const token = await global.oauth.settings.bot.accessToken
      if (token === '') return

      // user doesn't exist - get username from api GET https://api.twitch.tv/helix/users?id=<user ID>
      const url = `https://api.twitch.tv/helix/users?id=${fid}`
      let request
      try {
        request = await axios.get(url, {
          headers: {
            'Authorization': 'Bearer ' + token
          }
        })

        // save remaining api calls
        global.api.calls.bot.limit = request.headers['ratelimit-limit']
        global.api.calls.bot.remaining = request.headers['ratelimit-remaining']
        global.api.calls.bot.refresh = request.headers['ratelimit-reset']

        global.panel.io.emit('api.stats', { data: request.data, timestamp: _.now(), call: 'webhooks.follower', api: 'helix', endpoint: url, code: request.status, remaining: global.api.calls.bot.remaining })

        if (!await global.commons.isBot(request.data.data[0].login)) {
          global.overlays.eventlist.add({
            type: 'follow',
            username: request.data.data[0].login
          })

          const followedAt = user.lock && user.lock.followed_at ? Number(user.time.follow) : parseInt(_.now(), 10)
          const isFollower = user.lock && user.lock.follower ? user.is.follower : true
          await global.db.engine.update('users', { id: fid }, { id: fid, username: request.data.data[0].login, is: { follower: isFollower }, time: { followCheck: new Date().getTime(), follow: followedAt } })
          global.log.follow(request.data.data[0].login)
          global.events.fire('follow', { username: request.data.data[0].login, webhooks: true })
        }
      } catch (e) {
        global.panel.io.emit('api.stats', { data: request.data, timestamp: _.now(), call: 'webhooks.follower', api: 'helix', endpoint: url, code: e.stack, remaining: global.api.calls.bot.remaining })
      }
    } else {
      if (!_.get(user, 'is.follower', false) && _.now() - _.get(user, 'time.follow', 0) > 60000 * 60) {
        if (!await global.commons.isBot(user.username)) {
          global.overlays.eventlist.add({
            type: 'follow',
            username: user.username
          })
          global.log.follow(user.username)
          global.events.fire('follow', { username: user.username, webhooks: true })
        }
      }

      if (!_.get(user, 'is.follower', false)) global.users.set(user.username, { id: fid, time: { followCheck: new Date().getTime() } })
      else {
        const followedAt = user.lock && user.lock.followed_at ? Number(user.time.follow) : parseInt(_.now(), 10)
        const isFollower = user.lock && user.lock.follower ? user.is.follower : true
        global.users.set(user.username, { id: fid, is: { follower: isFollower }, time: { followCheck: new Date().getTime(), follow: followedAt } })
      }
    }
  }

  /*
    Example aEvent payload
    {
      "data":
        [{
          "id":"0123456789",
          "user_id":"5678",
          "game_id":"21779",
          "community_ids":[],
          "type":"live",
          "title":"Best Stream Ever",
          "viewer_count":417,
          "started_at":"2017-12-01T10:09:45Z",
          "language":"en",
          "thumbnail_url":"https://link/to/thumbnail.jpg"
        }]
    }
  */
  async stream (aEvent) {
    const cid = global.oauth.channelId
    if (cid === '') setTimeout(() => this.stream(aEvent), 1000) // wait until channelId is set

    // stream is online
    if (aEvent.data.length > 0) {
      let stream = aEvent.data[0]

      if (parseInt(stream.user_id, 10) !== parseInt(cid, 10) || Number(stream.id) === Number(global.api.streamId)) return

      // Always keep this updated
      global.api.streamStartedAt = stream.started_at
      global.api.streamId = stream.id
      global.api.streamType = stream.type

      await global.db.engine.update('api.current', { key: 'title' }, { value: stream.title })
      await global.db.engine.update('api.current', { key: 'game' }, { value: await global.api.getGameFromId(stream.game_id) })

      if (!await global.cache.isOnline() || global.twitch.streamType !== stream.type) {
        if (__DEBUG__.STREAM) {
          global.log.debug('WEBHOOKS: ' + JSON.stringify(aEvent))
        }
        global.log.start(
          `id: ${stream.id} | startedAt: ${stream.started_at} | title: ${stream.title} | game: ${await global.api.getGameFromId(stream.game_id)} | type: ${stream.type} | channel ID: ${cid}`
        )
        global.cache.when({ online: stream.started_at })
        global.api.chatMessagesAtStart = global.linesParsed

        global.events.fire('stream-started')
        global.events.fire('command-send-x-times', { reset: true })
        global.events.fire('keyword-send-x-times', { reset: true })
        global.events.fire('every-x-minutes-of-stream', { reset: true })
      }

      global.api.curRetries = 0
      global.api.saveStreamData(stream)
      global.api.streamType = stream.type
      await global.cache.isOnline(true)
    } else {
      // stream is offline - add curRetry + 1 and call getCurrentStreamData to do retries
      global.api.curRetries = global.api.curRetries + 1
      global.api.getCurrentStreamData(({ interval: false }))
    }
  }
}

module.exports = Webhooks
