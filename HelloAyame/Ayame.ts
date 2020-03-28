import {NativeModules, Platform} from 'react-native';
import EventTarget from 'event-target-shim';

import {
  RTCConfiguration,
  RTCLogger as logger,
  RTCEvent,
  RTCIceServer,
  RTCIceCandidate,
  RTCMediaConstraints,
  RTCMediaStream,
  RTCMediaStreamConstraints,
  RTCPeerConnection,
  RTCSessionDescription,
  getUserMedia,
  stopUserMedia,
  // @ts-ignore
} from 'react-native-webrtc-kit';

export class AyameEvent extends RTCEvent {}

enum AyameConnectionState {
  New = 'new',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnected = 'disconnected',
}

enum AyameSignalingType {
  Register = 'register',
  Accept = 'accept',
  Reject = 'reject',
  Candidate = 'candidate',
  Offer = 'offer',
  Answer = 'answer',
  Ping = 'ping',
  Pong = 'pong',
}

export class AyameSignalingMessage {
  type: string = '';
  roomId?: string = '';
  clientId?: string = '';
  key?: string = ''; //  シグナリングキー
  sdp?: any = null;
  video?: boolean | Object | null = null;
  audio?: boolean | Object | null = null;
  candidate?: Object | null = null;
  ice?: Object | null = null;
  data?: any;

  constructor(type: AyameSignalingType) {
    this.type = type;
  }
}

type AyameEventType = 'connectionstatechange' | 'track' | 'disconnect';

export const AyameEvents: Array<AyameEventType> = [
  'connectionstatechange',
  'track',
  'disconnect',
];

export class AyameEventTarget extends EventTarget(AyameEvents) {}

/**
 * WebRTC Signaling Server Ayame サーバーとの接続を行うクラス
 */
export class Ayame extends AyameEventTarget {
  signalingUrl: string;
  roomId: string;
  clientId: string;
  signalingKey: string;
  connectionState: AyameConnectionState = AyameConnectionState.New;
  configuration: any;

  _ws: any;
  _pc: any;
  _isOffer: boolean;

  ondisconnect: any;
  onconnectionstatechange: any;

  constructor(
    signalingUrl: string,
    roomId: string,
    clientId: string,
    signalingKey: string,
  ) {
    super();
    this.signalingUrl = signalingUrl;
    this.roomId = roomId;
    this.clientId = clientId;
    this.signalingKey = signalingKey;
    this._isOffer = false;
    this.configuration = new RTCConfiguration();
    this.configuration.sdpSemantics = 'unified';
  }

  _send(message: AyameSignalingMessage) {
    if (this._ws !== null) {
      logger.group('# Ayame: send signaling message =>', message.type);
      const json = JSON.stringify(message);
      this._ws.send(json);
      logger.groupEnd();
    }
  }

  connect() {
    logger.log('# Ayame: connect');
    this._ws = new WebSocket(this.signalingUrl);
    this._ws.onopen = this._onWebSocketOpen.bind(this);
    this._ws.onclose = this._onWebSocketClose.bind(this);
    this._ws.onmessage = this._onWebSocketMessage.bind(this);
    this._ws.onerror = this._onAnyError.bind(this);
  }

  disconnect() {
    logger.log('# Ayame: disconnect');
    this._isOffer = false;
    this.configuration = new RTCConfiguration();
    this.configuration.sdpSemantics = 'unified';
    if (this._pc) {
      this._pc.close();
      this._pc = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    stopUserMedia();
    if (this.ondisconnect != null) {
      this.ondisconnect();
    }
  }

  _setConnectionState(state: AyameConnectionState) {
    logger.log('# Ayame: set connection state => ', state);
    this.connectionState = state;
    this.dispatchEvent(new RTCEvent('connectionstatechange'));
  }

  async _createPeerConnection() {
    logger.group('# Ayame: create new peer connection');
    const pc = new RTCPeerConnection(this.configuration);
    const info = await getUserMedia(null);
    logger.log('# Ayame: getUserMedia: get info =>', info);
    // peer connection に自分の track を追加する
    info.tracks.forEach((track: object) =>
      pc.addTrack(track, [info.streamId]).catch((e: string) => {
        throw new Error(e);
      }),
    );

    pc.onconnectionstatechange = this._onConnectionStateChange.bind(this);
    pc.onsignalingstatechange = this._onSignalingStateChange.bind(this);
    pc.onicecandidate = this._onIceCandidate.bind(this);
    pc.oniceconnectionstatechange = this._onIceConnectionStateChange.bind(this);
    pc.onicegatheringstatechange = this._onIceGatheringStateChange.bind(this);
    pc.ontrack = this._onTrack.bind(this);
    if (Platform.OS === 'ios') {
      // Android は現状 onRemoveTrack を検知できないので、iOS のみ onRemoveTrack を bind している。
      pc.onremovetrack = this._onRemoveTrack.bind(this);
    }
    logger.groupEnd();
    return pc;
  }

  async _onWebSocketOpen() {
    logger.group('# Ayame: WebSocket is opened');
    this._setConnectionState(AyameConnectionState.Connecting);
    // register メッセージを送信する
    var register = new AyameSignalingMessage(AyameSignalingType.Register);
    register.roomId = this.roomId;
    register.clientId = this.clientId;
    if (this.signalingKey && this.signalingKey.length > 0) {
      register.key = this.signalingKey;
    }
    this._send(register);
    logger.groupEnd();
  }

  _onWebSocketClose() {
    logger.log('# Ayame: WebSocket is closed');
    if (this._pc) {
      this._pc.close();
    }
  }

  async _onWebSocketMessage(message: any) {
    try {
      logger.group('# Ayame: received WebSocket message', message.data);
      const signal = JSON.parse(message.data);
      logger.log('# Ayame: signaling type => ', signal.type);
      logger.log('# Ayame: connection state => ', this.connectionState);
      switch (signal.type) {
        case 'accept':
          logger.log('# Ayame: accepted client');
          if (signal.iceServers && Array.isArray(signal.iceServers)) {
            // iceServers をセットする
            let iceServers = [];
            for (const iceServer of signal.iceServers) {
              logger.log('# Ayame: ICE server => ', iceServer);
              for (const url of iceServer.urls) {
                iceServers.push(
                  new RTCIceServer(
                    iceServer.urls,
                    iceServer.username,
                    iceServer.credential,
                  ),
                );
              }
            }
            this.configuration.iceServers = iceServers;
          }
          if (!this._pc) this._pc = await this._createPeerConnection();
          if (signal.isExistClient) await this._sendOffer();
          break;
        case 'reject':
          logger.log('# Ayame: rejected', signal);
          this.disconnect();
          break;
        case 'answer':
          logger.log('# Ayame: answer set remote description => ', signal);
          await this._setAnswer(signal);
          break;
        case 'offer':
          await this._setOffer(signal);
          break;
        case 'candidate':
          await this._setCandidate(signal);
          break;
        case 'ping':
          // ping-pong
          this._ws.send(JSON.stringify({type: AyameSignalingType.Pong}));
          break;
        default:
          logger.log('# Ayame: signaling unknown');
          break;
      }
      logger.groupEnd();
    } catch (error) {
      logger.log('# Ayame: Error', error);
      this._onAnyError(error);
    }
  }

  _onConnectionStateChange(event: any) {
    logger.group('# Ayame: connection state changed => ', event.type);
    const oldState: AyameConnectionState = this.connectionState;

    var newState: AyameConnectionState | 'failed' | 'closed' =
      AyameConnectionState.Disconnected;
    if (this._pc) {
      newState = this._pc.connectionState;
    }
    switch (newState) {
      case 'new':
        newState = AyameConnectionState.New;
        break;
      case 'connecting':
        newState = AyameConnectionState.Connecting;
        break;
      case 'connected':
        newState = AyameConnectionState.Connected;
        this._isOffer = false;
        break;
      case 'failed':
      case 'closed':
        newState = AyameConnectionState.Disconnected;
        break;
      default:
        return;
    }
    logger.log('# Ayame: set new connection state => ', newState);
    this.connectionState = newState;
    if (oldState !== newState) {
      // @ts-ignore
      this.dispatchEvent(new AyameEvent('connectionstatechange'));
    }
    logger.groupEnd();
  }

  _onSignalingStateChange(event: any) {
    logger.log(
      '# Ayame: peer connection signaling state changed => ',
      event.type,
    );
  }

  _onIceCandidate(event: any) {
    logger.group('# Ayame: ICE candidate changed', event.candidate);
    if (event.candidate != null) {
      var msg = {
        type: 'candidate',
        ice: {
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid,
        },
      };
      logger.log('# Ayame: send candidate => ', msg);
      this._send(msg);
    }
    logger.groupEnd();
  }

  _onIceConnectionStateChange(event: object) {
    logger.log('# Ayame: ICE connection state changed');
  }

  async _sendOffer() {
    if (!this._pc) {
      return;
    }
    const offer = await this._pc.createOffer(new RTCMediaStreamConstraints());
    await this._pc.setLocalDescription(offer);
    this._sendSdp(this._pc.localDescription);
    this._isOffer = true;
  }

  async _setAnswer(sessionDescription: any) {
    if (!this._pc) {
      return;
    }
    await this._pc.setRemoteDescription(
      new RTCSessionDescription(
        sessionDescription.type,
        sessionDescription.sdp,
      ),
    );
  }

  async _setOffer(sessionDescription: any) {
    this._pc = await this._createPeerConnection();
    logger.log('# Ayame: offer set remote description => ', sessionDescription);
    await this._pc.setRemoteDescription(
      new RTCSessionDescription(
        sessionDescription.type,
        sessionDescription.sdp,
      ),
    );
    const answer = await this._pc.createAnswer(this.configuration);
    logger.log('# Ayame: create answer');
    await this._pc.setLocalDescription(answer);
    this._sendSdp(this._pc.localDescription);
  }

  async _setCandidate(ice: any) {
    if (!this._pc) {
      return;
    }
    if (ice && ice.candidate) {
      try {
        const candidate = new RTCIceCandidate(ice.candidate);
        await this._pc.addIceCandidate(candidate);
      } catch (_e) {
        // TODO(kdxu): ice candidate の追加に失敗するときがあるので調べる
      }
    }
  }

  _sendSdp(sessionDescription: AyameSignalingMessage) {
    this._send(sessionDescription);
  }

  _onIceGatheringStateChange() {
    logger.log('# Ayame: ICE gathering state changed');
  }

  _onTrack(event: any) {
    logger.log('# Ayame: track added =>', event.track);
    // @ts-ignore
    this.dispatchEvent(new AyameEvent('track', event));
  }

  _onRemoveTrack(event: object) {
    logger.log('# Ayame: track removed =>', event);
  }

  _onAnyError(error: object) {
    logger.log('# Ayame: any error => ', error);
  }
}
