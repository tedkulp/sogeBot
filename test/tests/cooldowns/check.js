/* global describe it beforeEach */
if (require('cluster').isWorker) process.exit()

require('../../general.js')

const assert = require('chai').assert

const db = require('../../general.js').db
const message = require('../../general.js').message
const variable = require('../../general.js').variable

// users
const owner = { username: 'soge__' }
const testUser = { username: 'test' }
const testUser2 = { username: 'test2' }

describe('Cooldowns - check()', () => {
  beforeEach(async () => {
    await db.cleanup()
    await message.prepare()

    global.games.gamble.settings.enabled = true
    await variable.isEqual('global.games.gamble.settings.enabled', true)
  })

  it('#1406 - cooldown not working on gamble', async () => {
    let [command, type, seconds, quiet] = ['!gamble', 'user', '300', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: '!gamble' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: '!gamble 10' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: '!gamble 15' })
    assert.isFalse(isOk) // second should fail

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: '!gamble 20' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: '!gamble 25' })
    assert.isFalse(isOk) // second should fail
  })

  it('#1352 - command in a sentence', async () => {
    let [command, type, seconds, quiet] = ['!test', 'user', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: '!test' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: 'Lorem Ipsum !test' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: 'Lorem Ipsum !test' })
    assert.isTrue(isOk) // second should fail
  })

  it('command with subcommand - user', async () => {
    let [command, type, seconds, quiet] = ['!test me', 'user', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: '!test me' })
    assert.notEmpty(item)

    assert.isTrue(await global.systems.cooldown.check({ sender: testUser, message: command }), `'${command}' expected to not fail`)
    assert.isFalse(await global.systems.cooldown.check({ sender: testUser, message: command }), `'${command}' expected to fail`)
    assert.isTrue(await global.systems.cooldown.check({ sender: testUser2, message: command }), `'${command}' expected to not fail`)

    assert.isTrue(await global.systems.cooldown.check({ sender: testUser, message: '!test' }))
    assert.isTrue(await global.systems.cooldown.check({ sender: testUser, message: '!test' }))
    assert.isTrue(await global.systems.cooldown.check({ sender: testUser2, message: '!test' }))
  })

  it('command - user', async () => {
    let [command, type, seconds, quiet] = ['!test', 'user', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: '!test' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: '!test' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: '!test' })
    assert.isFalse(isOk) // second should fail

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: '!test' })
    assert.isTrue(isOk)
  })

  it('command - global', async () => {
    let [command, type, seconds, quiet] = ['!test', 'global', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: '!test' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: '!test' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: '!test' })
    assert.isFalse(isOk) // second should fail

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: '!test' })
    assert.isFalse(isOk) // another user should fail as well
  })

  it('keyword - user', async () => {
    global.systems.keywords.add({ sender: owner, parameters: 'me (!me)' })
    await message.isSent('keywords.keyword-was-added', owner, { keyword: 'me', sender: owner.username })

    let [command, type, seconds, quiet] = ['me', 'user', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: 'me' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: 'me' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: 'me' })
    assert.isFalse(isOk) // second should fail

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: 'me' })
    assert.isTrue(isOk)
  })

  it('keyword - global', async () => {
    global.systems.keywords.add({ sender: owner, parameters: 'me (!me)' })
    await message.isSent('keywords.keyword-was-added', owner, { keyword: 'me', sender: owner.username })

    let [command, type, seconds, quiet] = ['me', 'global', '60', true]
    global.systems.cooldown.main({ sender: owner, parameters: `${command} ${type} ${seconds} ${quiet}` })
    await message.isSent('cooldowns.cooldown-was-set', owner, { command: command, type: type, seconds: seconds, sender: owner.username })

    let item = await global.db.engine.findOne('systems.cooldown', { key: 'me' })
    assert.notEmpty(item)

    let isOk = await global.systems.cooldown.check({ sender: testUser, message: 'me' })
    assert.isTrue(isOk)

    isOk = await global.systems.cooldown.check({ sender: testUser, message: 'me' })
    assert.isFalse(isOk) // second should fail

    isOk = await global.systems.cooldown.check({ sender: testUser2, message: 'me' })
    assert.isFalse(isOk) // another user should fail as well
  })
})
