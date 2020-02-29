import {
  Room as WechatyRoom,
  Contact as WechatyUser,
  Wechaty,
}                             from 'wechaty'

import {
  MatrixRoom,
  MatrixUser,
}                             from 'matrix-appservice-bridge'

import {
  log,
}                            from './config'
import { WechatyManager }     from './wechaty-manager'
import { AppserviceManager }  from './appservice-manager'
import { Manager } from './manager'

interface MiddleRoomData {
  consumerId : string   // the matrix user id who is using the matrix-appservice-wechaty

  /**
   * 1 or 2:
   *  directUserId & wechatyRoomId should only be set one, and leave the other one to be undefined.
   */

  /*
   * 1. If matrixUserId is set, then this room is a direct message room, between the consumerId and matrixUserId
   */
  matrixUserId? : string // for a direct message room (user to user private message, exactly 2 people)
  /**
   * 2. If wechatyRoomId is set, then this room is a group room, linked to the wechatyRoomId as well.
   */
  wechatyRoomId? : string // for a group room (not direct message, >2 people)
}

interface MiddleUserData {
  consumerId    : string  // the matrix user who is using the matrix-appservice-wechaty
  wechatyUserId : string  // the wechaty contact id that this user linked to
}

interface DirectMessageUserPair {
  user    : MatrixUser,
  service : MatrixUser,
}

const APPSERVICE_NAME_POSTFIX = '(Wechaty Bridged)'

const WECHATY_ROOM_DATA_KEY = 'wechatyBridgeRoom'
const WECHATY_USER_DATA_KEY = 'wechatyBridgeUser'

export class MiddleManager extends Manager {

  private wechatyManager!: WechatyManager
  private appserviceManager!: AppserviceManager

  constructor () {
    super()
  }

  teamManager (managers: {
    wechatyManager    : WechatyManager,
    appserviceManager : AppserviceManager,
  }) {
    this.wechatyManager    = managers.wechatyManager
    this.appserviceManager = managers.appserviceManager
  }

  public async matrixUser (wechatyUser: WechatyUser) : Promise<MatrixUser>
  public async matrixUser (matrixUserId: string)     : Promise<MatrixUser>

  public async matrixUser (
    user: string | WechatyUser,
  ): Promise<MatrixUser> {
    log.verbose('MiddleManager', 'matrixUser(%s)', user)

    if (typeof user === 'string') {
      const matrixUser = await this.appserviceManager.userStore.getMatrixUser(user)
      if (matrixUser) {
        return matrixUser
      }
      throw new Error(`matrix user id ${user} not found in store`)
    }

    const wechaty    = user.wechaty
    const consumerId = this.wechatyManager.matrixConsumerId(wechaty)

    const userData: MiddleUserData = {
      consumerId,
      wechatyUserId: user.id,
    }

    const query = this.appserviceManager.storeQuery(
      WECHATY_USER_DATA_KEY,
      userData,
    )

    const matrixUserList = await this.appserviceManager.userStore
      .getByMatrixData(query)

    const matrixUser = matrixUserList.length > 0
      ? matrixUserList[0]
      : this.generateMatrixUser(user, userData)

    return matrixUser
  }

  /**
   * Get wechaty.userSelf() for consumerId
   */
  public async wechatyUser (consumerId: string) : Promise<WechatyUser>
  /**
   * Get binded wechaty contact from the direct message room
   */
  public async wechatyUser (room: MatrixRoom)   : Promise<WechatyUser>
  /**
   * Get the mapped wechaty contact from the matrix user
   */
  public async wechatyUser (user: MatrixUser)   : Promise<WechatyUser>

  public async wechatyUser (
    idOrRoomOrUser: string | MatrixRoom | MatrixUser,
  ): Promise<WechatyUser> {
    log.verbose('MiddleManager', 'wechatyUser(%s)',
      typeof idOrRoomOrUser === 'string'
        ? idOrRoomOrUser
        : idOrRoomOrUser.getId(),
    )

    let matchKey: string

    if (typeof idOrRoomOrUser === 'string') {

      const wechaty = this.wechatyManager.wechaty(idOrRoomOrUser)
      if (!wechaty) {
        throw new Error('no wechaty instance for matrix user id ' + idOrRoomOrUser)
      }
      return wechaty.userSelf()

    } else if (idOrRoomOrUser instanceof MatrixRoom) {
      matchKey = WECHATY_ROOM_DATA_KEY
    } else if (idOrRoomOrUser instanceof MatrixUser) {
      matchKey = WECHATY_USER_DATA_KEY
    } else {
      throw new Error('unknown args')
    }

    const data = {
      ...idOrRoomOrUser.get(matchKey),
    } as Partial<MiddleUserData>

    if (!data.consumerId) {
      throw new Error('no owner id for matrix room ' + idOrRoomOrUser.getId())
    }
    if (!data.wechatyUserId) {
      throw new Error('no wechaty user id for matrix room ' + idOrRoomOrUser.getId())
    }

    const consumerId       = data.consumerId
    const wechatyUserId = data.wechatyUserId

    const wechaty = this.wechatyManager.wechaty(consumerId)
    if (!wechaty) {
      throw new Error('no wechaty instance for matrix user id ' + consumerId)
    }

    const wechatyContact = await wechaty.Contact
      .find({ id: wechatyUserId })

    if (!wechatyContact) {
      throw new Error('no wechaty contact found for id: ' + wechatyUserId)
    }
    return wechatyContact
  }

  /**
   * Group Room
   */
  public async matrixRoom (wechatyRoom: WechatyRoom): Promise<MatrixRoom>
  /**
   * Direct Message Room
   */
  public async matrixRoom (wechatyUser: WechatyUser): Promise<MatrixRoom>

  public async matrixRoom (
    wechatyUserOrRoom: WechatyUser | WechatyRoom,
  ): Promise<MatrixRoom> {
    log.verbose('MiddleManager', 'matrixRoom(%s)', wechatyUserOrRoom)

    const consumerId = this.wechatyManager.matrixConsumerId(wechatyUserOrRoom.wechaty)

    const data = { consumerId } as MiddleRoomData

    if (wechatyUserOrRoom instanceof WechatyUser) {
      const matrixUser = await this.matrixUser(wechatyUserOrRoom)
      data.matrixUserId = matrixUser.getId()
    } else if (wechatyUserOrRoom instanceof WechatyRoom) {
      data.wechatyRoomId = wechatyUserOrRoom.id
    } else {
      throw new Error('unknown args')
    }

    const query = this.appserviceManager.storeQuery(
      WECHATY_ROOM_DATA_KEY,
      data,
    )

    const entryList = await this.appserviceManager.roomStore
      .getEntriesByMatrixRoomData(query)

    const matrixRoom = entryList.length > 0
      ? entryList[0].matrix
      : await this.generateMatrixRoom(wechatyUserOrRoom, data)

    if (!matrixRoom) {
      throw new Error('get matrix room failed')
    }
    return matrixRoom
  }

  public async wechatyRoom (
    room: MatrixRoom,
  ): Promise<WechatyRoom> {
    log.verbose('MiddleManager', 'wechatyRoom(%s)', room.getId())

    const {
      consumerId,
      wechatyRoomId,
    } = {
      ...room.get(WECHATY_ROOM_DATA_KEY),
    } as MiddleRoomData

    if (!wechatyRoomId) {
      throw new Error('no wechaty room id for matrix room ' + room.getId())
    }
    if (!consumerId) {
      throw new Error('no owner id for matrix room ' + room.getId())
    }

    const wechaty = this.wechatyManager.wechaty(consumerId)
    if (!wechaty) {
      throw new Error('no wechaty instance for matrix user id ' + room.getId())
    }

    const wechatyRoom = await wechaty.Room
      .find({ id: wechatyRoomId })
    if (!wechatyRoom) {
      throw new Error('no wechaty room found for id: ' + wechatyRoomId)
    }
    return wechatyRoom
  }

  protected async generateMatrixUser (
    wechatyUser : WechatyUser,
    userData    : MiddleUserData,
  ): Promise<MatrixUser> {
    log.verbose('MiddleManager', 'generateMatrixUser(%s, "%s")',
      wechatyUser.id,
      JSON.stringify(userData),
    )

    const matrixUserId = this.appserviceManager.generateVirtualUserId()
    const matrixUser   = new MatrixUser(matrixUserId)

    // userData.name   = wechatyUser.name() + APPSERVICE_NAME_POSTFIX

    matrixUser.set(WECHATY_USER_DATA_KEY, userData)
    await this.appserviceManager.userStore.setMatrixUser(matrixUser)

    return matrixUser
  }

  /**
   * Room: Group Room
   * User: Direct Message Room
   */
  protected async generateMatrixRoom (
    wechatyRoomOrUser : WechatyRoom | WechatyUser,
    roomData          : MiddleRoomData,
  ): Promise<MatrixRoom> {
    log.verbose('MiddleManager', 'generateMatrixRoom(%s, %s)',
      wechatyRoomOrUser,
      JSON.stringify(roomData),
    )

    const wechaty = wechatyRoomOrUser.wechaty
    const consumerId = this.wechatyManager.matrixConsumerId(wechaty)

    const inviteeIdList = [ consumerId ]
    let   roomName: string

    if (wechatyRoomOrUser instanceof WechatyRoom) {
      // Room: group
      roomName = await wechatyRoomOrUser.topic()
      for await (const member of wechatyRoomOrUser) {
        const matrixUser = await this.matrixUser(member)
        inviteeIdList.push(matrixUser.getId())
      }
    } else if (wechatyRoomOrUser instanceof WechatyUser) {
      // User: direct message
      roomName = wechatyRoomOrUser.name()
      const matrixUser = await this.matrixUser(wechatyRoomOrUser)
      inviteeIdList.push(matrixUser.getId())
    } else {
      throw new Error('unknown args')
    }

    const matrixRoom = await this.createGroupRoom(inviteeIdList, roomName)

    matrixRoom.set(WECHATY_ROOM_DATA_KEY, roomData)
    await this.appserviceManager.roomStore.setMatrixRoom(matrixRoom)

    return matrixRoom
  }

  /**
   * The group room will be created by the bot itself.
   */
  protected async createGroupRoom (
    matrixUserIdList : string[],
    topic            : string,
  ): Promise<MatrixRoom> {
    log.verbose('MiddleManager', 'createGroupRoom(["%s"], "%s")',
      matrixUserIdList.join('","'),
      topic,
    )

    // use bot intent to create a group room
    const intent = this.appserviceManager.bridge.getIntent()

    /**
     * See:
     *  Issue #4 - https://github.com/wechaty/matrix-appservice-wechaty/issues/4
     *  Client Server API Spec - https://matrix.org/docs/spec/client_server/r0.6.0#id140
     *  https://github.com/matrix-org/matrix-js-sdk/issues/653#issuecomment-393371939
     */
    const roomInfo = await intent.createRoom({
      createAsClient: true,
      options: {
        invite     : matrixUserIdList,
        is_direct  : false,
        name       : topic + APPSERVICE_NAME_POSTFIX,
        preset     : 'trusted_private_chat',
        visibility : 'private',
      },

    })

    const matrixRoom = new MatrixRoom(roomInfo.room_id)
    return matrixRoom
  }

  public async setDirectMessageRoom (
    args: {
      consumer   : MatrixUser,
      matrixUser : MatrixUser,
      matrixRoom : MatrixRoom,
    }
  ) {
    log.verbose('MiddleManager', 'DirectMessageRoom({matrixId: %s, matrixUserId: %s, matrixRoomId: %s})',
      args.consumer.getId(),
      args.matrixUser.getId(),
      args.matrixRoom.getId(),
    )

    const data: MiddleRoomData = {
      ...args.matrixRoom.get(WECHATY_ROOM_DATA_KEY),
      consumerId   : args.consumer.getId(),
      matrixUserId : args.matrixUser.getId(),
    }

    args.matrixRoom.set(
      WECHATY_ROOM_DATA_KEY,
      data,
    )
    await this.appserviceManager.roomStore.setMatrixRoom(args.matrixRoom)
  }

  /**
   * See: Issue #4 - https://github.com/wechaty/matrix-appservice-wechaty/issues/4
   *  - https://github.com/matrix-org/matrix-js-sdk/issues/653#issuecomment-420808454
   */
  public async isDirectMessageRoom (
    matrixRoom: MatrixRoom,
  ): Promise<boolean> {
    log.verbose('MiddleManager', 'isDirectMessageRoom(%s)', matrixRoom.getId())

    // // getMyMembership -> "invite", "join", "leave", "ban"
    // const membership = matrixRoom.getMyMembership()
    // const type = matrixRoom.getDMInviter() ? 'directMessage' : 'room'
    // return membership === 'invite' && type === 'directMessage'

    const {
      matrixUserId,
    } = {
      ...matrixRoom.get(WECHATY_ROOM_DATA_KEY),
    } as Partial<MiddleRoomData>

    const isDM = !!matrixUserId

    log.silly('MiddleManager', 'isDirectMessageRoom() -> %s', isDM)
    return isDM
  }

  public async directMessageUserPair (
    matrixRoom: MatrixRoom,
  ): Promise<DirectMessageUserPair> {
    log.verbose('MiddleManager', 'directMessageUserPair(%s)', matrixRoom.getId())

    const {
      consumerId,
      matrixUserId,
    } = {
      ...matrixRoom.get(
        WECHATY_ROOM_DATA_KEY
      ),
    } as MiddleRoomData
    if (!matrixUserId) {
      throw new Error('no matrix user id found)')
    }

    const service = await this.matrixUser(matrixUserId)
    const user    = await this.matrixUser(consumerId)

    return {
      service,
      user,
    }
  }

  /**
   * Send message from service bot to the bridge consumer
   */
  public async directMessageToMatrixConsumer (text: string, from: Wechaty): Promise<void>
  /**
   * Send message from user to the bridge consumer
   */
  public async directMessageToMatrixConsumer (text: string, from: WechatyUser): Promise<void>

  public async directMessageToMatrixConsumer (
    text: string,
    from: WechatyUser | Wechaty,
  ): Promise<void> {
    log.verbose('MiddleManager', 'directMessageToMatrixConsumer("%s", "%s")',
      text,
      from
    )

    let matrixRoom
    let matrixUser

    if (from instanceof WechatyUser) {

      matrixRoom = await this.matrixRoom(from)
      matrixUser = await this.matrixUser(from)

    } else if (from instanceof Wechaty) {

      const consumerId = this.wechatyManager.matrixConsumerId(from)
      matrixRoom = await this.appserviceManager.adminRoom(consumerId)

    } else {
      throw new Error('unknown args')
    }

    await this.appserviceManager.sendMessage(
      text,
      matrixRoom,
      matrixUser,
    )
  }

}
