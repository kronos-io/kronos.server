const create_server = require("net").createServer
const uuid = require("uuid").v4

const $task    = require("./task")
const $user    = require("./user")
const $device  = require("./device")
const $session = require("./session")

const port = 5000 || process.env.PORT

// -------------------------------------------------------------- # Public API #

function start(conn) {
  const server = create_server(on_create_server(conn))

  server.on("error", on_error)
  server.listen(port, on_listen)
}

function on_error(e) {
  throw e
}

module.exports = {
  start,
  on_error,
}

// ------------------------------------------------------------- # Private API #

function on_create_server(conn) {
  return (client) => {
    const session_id = $session.create()
    console.log(`New session "${session_id}"`)

    const params = {conn, client, session_id}
    client.on("end",  on_client_end(params))
    client.on("data", on_client_data(params))
  }
}

function on_client_end({conn, session_id}) {
  return async () => {
    const device_id = $session.delete_(session_id)
    console.log(`End session "${session_id}"`)

    if (device_id) {
      await $device.disconnect(conn, device_id)
      console.log(`Disconnect device "${session_id}"`)
    }
  }
}

function on_client_data(params) {
  return async (raw_data) => {
    const params_ = {...params, raw_data}

    try {
      await on_client_data_(params_)
    } catch (e) {
      send_error(params.client, e.message)
      console.warn(e.message)
    }
  }
}

async function on_client_data_({conn, client, session_id, raw_data}) {
  const data = parse_raw_data(raw_data)
  const {type, user_id, device_id, task, tasks, task_id, version} = data

  if (! type) throw new Error("missing data type")

  if (type === "login") {
    const {user, device}
      = await login({conn, client, user_id, device_id, session_id})

    return await watch({conn, client, user, device})
  }

  switch (type) {
    case "read-all":
      return await read_all({conn, client, user_id})
    case "write-all":
      return await write_all({conn, user_id, tasks, version})
    case "create":
      return await create({conn, user_id, task, version})
    case "update":
      return await update({conn, user_id, task, version})
    case "delete":
      return await delete_({conn, user_id, task_id, version})
    default:
      throw new Error("invalid data type")
  }
}

async function watch(params) {
  const {client} = params
  const on_change = data => {
    send_success(client, data)
  }

  await $task.watch({...params, on_change})
}

async function read_all({conn, client, user_id}) {
  const tasks = await $task.read_all(conn, user_id)
  return send_success(client, {type: "read-all", tasks})
}

async function write_all({conn, user_id, tasks, version}) {
  await $task.write_all(conn, user_id, tasks)
  await $user.set_version({conn, user_id, version})
}

async function create(params) {
  const {conn, client, user_id, version} = params
  const task = parse_task(params.task)(user_id)
  await $task.create(conn, task)
  await $user.set_version({conn, user_id, version})
}

async function update(params) {
  const {conn, client, user_id, version} = params
  const task = parse_task(params.task)(user_id)
  await $task.update(conn, task)
  await $user.set_version({conn, user_id, version})
}

async function delete_(params) {
  const {conn, client, user_id, version} = params
  const task_id = parse_task_id(params.task_id)
  await $task.delete_(conn, task_id, user_id)
  await $user.set_version({conn, user_id, version})
}

async function login(params) {
  const {conn, client, session_id} = params

  const user_id = params.user_id || await $user.create(conn)
  const user = await $user.read(conn, user_id)

  const device_id = params.device_id || await $device.create(conn, user_id)
  const device = await $device.read(conn, device_id)

  await $device.connect(conn, device_id)
  $session.update(session_id, device_id)

  send_success(client, {
    type: "login",
    user_id,
    device_id,
    version: user.version,
  })

  return {user, device}
}

function parse_raw_data(raw_data) {
  try {
    const data = JSON.parse(raw_data)
    return {
      ...data,
      task: data.task || {},
      tasks: data.tasks || [],
      version: data.version || Date.now(),
      task_id: data.task_id || 0,
      user_id: data.user_id || "",
      device_id: data.device_id || "",
    }
  } catch (e) {
    throw new Error("invalid data")
  }
}

function parse_task_id(id) {
  if (! id) throw new Error("missing task id")
  if (typeof id !== "number") throw new Error("invalid task id")

  return id
}

function parse_task(obj) {
  return (user_id) => {
    if (! obj) throw new Error("missing task")

    parse_task_id(obj.id)

    if (! obj.desc) throw new Error("missing task desc")
    if (typeof obj.desc !== "string") throw new Error("invalid task desc")

    if (! obj.tags) throw new Error("missing task tags")
    if (obj.tags && ! Array.isArray(obj.tags)) throw new Error("invalid task tags")

    if (obj.active && typeof obj.active !== "number") throw new Error("invalid task active")
    if (obj.last_active && typeof obj.last_active !== "number") throw new Error("invalid task last_active")
    if (obj.due && typeof obj.due !== "number") throw new Error("invalid task due")
    if (obj.done && typeof obj.done !== "number") throw new Error("invalid task done")
    if (obj.worktime && typeof obj.worktime !== "number") throw new Error("invalid task worktime")

    return {
      ...obj,
      active: obj.active || 0,
      last_active: obj.last_active || 0,
      due: obj.due || 0,
      done: obj.done || 0,
      worktime: obj.worktime || 0,
      user_id,
    }
  }
}

function send_success(client, data = {}) {
  return send(client, {success: true, ...data})
}

function send_error(client, error) {
  return send(client, {success: false, error})
}

function send(client, data) {
  return client.write(JSON.stringify(data) + "\n")
}

function on_listen() {
  console.log(`Kronos server listening on port ${port}...`)
}