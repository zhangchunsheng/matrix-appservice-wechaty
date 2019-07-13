import {
  BridgeContext,
  Request,
  // RemoteUser,
}                   from 'matrix-appservice-bridge'

import {
  AGE_LIMIT_SECONDS,
  log,
}                     from './config'

import { AppserviceManager }  from './appservice-manager'
import { SuperEvent }         from './super-event'
import { WechatyManager }     from './wechaty-manager'
import { DialogManager } from './dialog-manager'

export class MatrixHandler {

  public appserviceManager! : AppserviceManager
  public wechatyManager!    : WechatyManager

  constructor (
    public dialogManager: DialogManager,
  ) {
    log.verbose('MatrixHandler', 'constructor()')
  }

  public setManager (
    appserviceManager : AppserviceManager,
    wechatyManager    : WechatyManager,
  ): void {
    this.appserviceManager = appserviceManager
    this.wechatyManager    = wechatyManager
  }

  public async onEvent (
    request : Request,
    context : BridgeContext,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'onEvent({type: "%s"}, {userId: "%s"})',
      request.data.type,
      context.senders.matrix.getId(),
    )
    // log.silly('MatrixHandler', 'onEvent("%s", "%s")',
    //   JSON.stringify(request),
    //   JSON.stringify(context),
    // )
    // console.info('request', request)
    // console.info('context', context)

    const superEvent = new SuperEvent(
      request,
      context,
      this.appserviceManager,
      this.wechatyManager,
    )

    /**
     * Put all the logical to processEvent()
     * because we need to add a try {} wrapper to all the codes
     * to prevent un-catched rejection.
     */

    try {

      await this.process(superEvent)

    } catch (e) {
      log.error('MatrixHandler', 'onEvent() rejection: %s', e && e.message)
      console.error(e)
    }
  }

  /**
   * Invoked when the bridge receives a user query from the homeserver. Supports
   * both sync return values and async return values via promises.
   * @callback Bridge~onUserQuery
   * @param {MatrixUser} matrixUser The matrix user queried. Use <code>getId()</code>
   * to get the user ID.
   * @return {?Bridge~ProvisionedUser|Promise<Bridge~ProvisionedUser, Error>}
   * Reject the promise / return null to not provision the user. Resolve the
   * promise / return a {@link Bridge~ProvisionedUser} object to provision the user.
   * @example
   * new Bridge({
   *   controller: {
   *     onUserQuery: function(matrixUser) {
   *       var remoteUser = new RemoteUser("some_remote_id");
   *       return {
   *         name: matrixUser.localpart + " (Bridged)",
   *         url: "http://someurl.com/pic.jpg",
   *         user: remoteUser
   *       };
   *     }
   *   }
   * });
   */
  public async onUserQuery (
    queriedUser: any,
  ): Promise<object> {
    log.verbose('MatrixHandler', 'onUserQuery("%s")', JSON.stringify(queriedUser))
    console.info('queriedUser', queriedUser)

    // if (isBridgeUser(matrixUserId)) {
    //   const wechaty = this.wechatyManager!.get(matrixUserId)
    //   const bridgeUser = new BridgeUser(matrixUserId, this.bridge!, wechaty)

    //   onBridgeUserUserQuery.call(bridgeUser, queriedUser)
    //     .catch(e => {
    //       log.error('AppServiceManager', 'onUserQuery() onBridgeUserUserQuery() rejection: %s', e && e.message)
    //     })
    // try {
    //   const provision = await onUserQuery.call(this, queriedUser)
    //   return provision
    // } catch (e) {
    //   log.error('AppServiceManager', 'onUserQuery() rejection: %s', e && e.message)
    // }

    // auto-provision users with no additonal data
    return {}
  }

  /****************************************************************************
   * Private Methods                                                         *
   ****************************************************************************/

  protected async process (
    superEvent : SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'process(superEvent)')

    /**
     * Matrix age is millisecond, convert second by multiple 1000
     */
    if (superEvent.age() > AGE_LIMIT_SECONDS * 1000) {
      log.verbose('MatrixHandler', 'process() skipping event due to age %s > %s',
        superEvent.age(), AGE_LIMIT_SECONDS * 1000)
      return
    }

    if (superEvent.isBotSender() || superEvent.isVirtualSender()) {
      log.verbose('MatrixHandler', 'process() virtual or appservice sender "%s" found, skipped.', superEvent.sender().getId())
      return
    }

    if (superEvent.isRoomInvitation()) {
      if (superEvent.isBotTarget()) {
        log.verbose('MatrixHandler', 'process() isRoomInvitation() appservice was invited')
        await this.processRoomInvitationToBot(superEvent)
      } else {
        log.verbose('MatrixHandler', 'process() isRoomInvitation() skipped for non-bot user: %s"', superEvent.target()!.getId())
      }
      return
    }

    switch (superEvent.type()) {

      case 'm.room.message':
        await this.processMatrixMessage(superEvent)
        break

      default:
        log.silly('MatrixHandler', 'process() default for type: ' + superEvent.type())
        console.info('DEBUG request', superEvent.request)
        console.info('DEBUG context', superEvent.context)
        break

    }

  }

  protected async processRoomInvitationToBot (
    superEvent: SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'processRoomInvitationToBot()')

    await superEvent.acceptRoomInvitation()

    const room   = superEvent.room()
    const sender = superEvent.sender()

    const memberIdDict = await this.appserviceManager.bridge.getBot()
      .getJoinedMembers(room.getId())

    const memberNum = Object.keys(memberIdDict).length

    if (memberNum === 2) {
      log.silly('MatrixHandler', 'process() room has 2 members, treat it as a direct room')
      // const directMessageRoom = await this.appserviceManager.directMessageRoomOf(sender)

      // if (!directMessageRoom) {
      await this.appserviceManager.directMessageRoom(sender, room)
      // }
    } else {
      log.silly('MatrixHandler', 'process() room has %s(!=2) members, it is not a direct room', memberNum)
    }
  }

  protected async processMatrixMessage (
    superEvent: SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'processMatrixRoomMessage(superEvent)')

    const matrixUser = superEvent.sender()
    const matrixRoom = superEvent.room()

    // console.info('DEBUG: matrixUser', matrixUser)
    // console.info('DEBUG: matrixUser.getId()', matrixUser.getId())
    // console.info('DEBUG: matrixUser.userId', (matrixUser as any).userId)
    // console.info('DEBUG: matrixRoom', matrixRoom)

    const filehelper = await this.wechatyManager
      .filehelperOf(matrixUser.getId())

    if (filehelper) {
      await filehelper.say(`Matrix user ${matrixUser.getId()} in room ${matrixRoom.getId()} said: ${superEvent.event.content!.body}`)
    }

    // const remoteRoom = superEvent.remoteRoom()
    // if (remoteRoom) {
    //   return this.forwardToRemoteRoom(superEvent)
    // }

    if (await superEvent.isDirectMessage()) {
      await this.processDirectMessage(superEvent)
    } else {
      await this.processGroupMessage(superEvent)
    }

  }

  protected async processDirectMessage (
    superEvent: SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'processDirectMessage()')

    const { user, service } = await superEvent.directMessageUserPair()
    const wechatyEnabled    = await this.appserviceManager.isEnabled(user)

    if (!wechatyEnabled) {
      await this.dialogManager.gotoEnableWechatyDialog(superEvent)
      return
    }

    /**
     * Enabled
     */

    if (this.appserviceManager.isBot(service.getId())) {

      await this.dialogManager.gotoSetupDialog(superEvent)

    } else if (this.appserviceManager.isVirtual(service.getId())) {

      await this.bridgeToWechatIndividual(superEvent)

    } else {
      throw new Error('unknown service id ' + service.getId())
    }

  }

  protected async processGroupMessage (
    superEvent: SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'processGroupMessage()')

    const matrixUser = superEvent.sender()

    const isEnabled = this.appserviceManager.isEnabled(matrixUser)

    if (!isEnabled) {
      log.silly('MatrixHandler', 'processRoomMessage() %s is not enabled for wechaty', matrixUser.getId())
      let directMessageRoom = await this.appserviceManager
        .directMessageRoom(matrixUser)
      if (!directMessageRoom) {
        directMessageRoom = await this.appserviceManager
          .createDirectRoom(matrixUser)
      }
      await this.appserviceManager.directMessage(
        directMessageRoom,
        'You did not enable wechaty appservice yet. please contact huan.',
      )
      // TODO: add action
      return
    }

    try {
      const roomPair = await superEvent.roomPair()
      if (!roomPair) {
        throw new Error('no room pair for super event')
      }

      const wechaty = this.wechatyManager.wechaty(matrixUser.getId())
      if (!wechaty) {
        throw new Error('no wechaty')
      }

      const wechatyRoom = await wechaty.Room.find({ id: roomPair.remote.getId() })
      if (!wechatyRoom) {
        throw new Error('no wechaty room for id: ' + roomPair.remote.getId())
      }

      await wechatyRoom.say(superEvent.event.content!.body!)

    } catch (e) {
      log.silly('MatrixHandler', 'onGroupMessage() roomPair() rejection: %s', e.message)
    }
  }

  protected async bridgeToWechatIndividual (
    superEvent: SuperEvent,
  ): Promise<void> {
    log.verbose('MatrixHandler', 'bridgeToWechatIndividual()')

    const { user, service } = await superEvent.directMessageUserPair()

    // const remoteUserList = await this.appserviceManager.userStore
    //   .getRemoteUsersFromMatrixId(service.getId())

    // if (remoteUserList.length === 0) {
    //   throw new Error('no remote in store for service id ' + service.getId())
    // }
    // const remoteUser = remoteUserList[0]

    const contact = await this.wechatyManager
      .wechatyContact(service, user)
    const text = superEvent.event.content!.body
    await contact.say(text + '')
  }

  // private async isKnownRoom (
  //   superEvent: SuperEvent,
  // ): Promise<boolean> {
  //   log.verbose('MatrixHandler', 'isKnownRoom()')

  //   const roomStore = await this.appserviceManager.bridge.getRoomStore()
  //   if (!roomStore) {
  //     throw new Error('no room store')
  //   }
  //   const matrixRoomId = superEvent.room().roomId
  //   const entrieList = roomStore.getEntriesByMatrixId(matrixRoomId)
  //   if (entrieList.length >= 0) {
  //     return true
  //   }
  //   return false
  // }

  /*
  { age: 43,
    content: { body: 'b', msgtype: 'm.text' },
    event_id: '$156165443741OCgSZ:aka.cn',
    origin_server_ts: 1561654437732,
    room_id: '!iMkbIwAOkbvCQbRoMm:aka.cn',
    sender: '@huan:aka.cn',
    type: 'm.room.message',
    unsigned: { age: 43 },
    user_id: '@huan:aka.cn' }
  */
  // private async replyUnknownRoom (
  //   superEvent: SuperEvent,
  // ): Promise<void> {
  //   log.verbose('MatrixHandler', 'replyUnnownRoom()')

  //   // const client = bridge.getClientFactory().getClientAs()
  //   // console.info('peeking')
  //   // await client.peekInRoom(event.room_id)

  //   // console.info('peeked')

  //   // const room = client.getRoom(event.room_id)
  //   // if (!room) {
  //   //   throw new Error('no room')
  //   // }
  //   // const dmInviter = room.getDMInviter()
  //   // console.info('dminviter', dmInviter)

  //   const memberDict = await this.appserviceManager.bridge.getBot().getJoinedMembers(superEvent.room().roomId)

  //   const wechatyVirtualIdList = Object.keys(memberDict)
  //     .filter(id => this.appserviceManager.bridge.getBot().isRemoteUser(id))

  //   if (wechatyVirtualIdList.length <= 0) {
  //     throw new Error('no wechaty virtual in the room')
  //   }

  //   const virtualId = wechatyVirtualIdList[0]
  //   console.info('virtualId', virtualId)

  //   // for (const member of memberList) {
  //   //   console.info('member', member)
  //   //   console.info('member id', member.userId)
  //   // }

  //   const intent = this.appserviceManager.bridge.getIntent(virtualId)
  //   await intent.sendText(superEvent.room().roomId, 'replyUnknownRoom: ' + superEvent.event.content!.body)
  // }

}
