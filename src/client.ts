import { Log, Util } from "mx-puppet-bridge";
import { EventEmitter } from "events";
import * as Bluebird from "bluebird";
import * as Toxcore from "js-toxcore-c";
import { Buffer } from "buffer";
const toxcore = Bluebird.promisifyAll(Toxcore);

const log = new Log("ToxPuppet:Client");

const nodes = [
	{ maintainer: "saneki",
		address: "96.31.85.154",
		port: 33445,
		key: "674153CF49616CD1C4ADF44B004686FC1F6C9DCDD048EF89B117B3F02AA0B778" },
	{ maintainer: "Impyy",
		address: "178.62.250.138",
		port: 33445,
		key: "788236D34978D1D5BD822F0A5BEBD2C53C64CC31CD3149350EE27D4D9A2F9B6B" },
	{ maintainer: "sonOfRa",
		address: "144.76.60.215",
		port: 33445,
		key: "04119E835DF3E78BACF0F84235B300546AF8B936F035185E2A8E9E0A67C8924F" },
];

export interface IToxFile {
	name: string;
	buffer: Buffer;
	size: number;
	kind: "data" | "avatar";
}

interface IMessageQueueEntry {
	type: "text" | "file";
	text?: string;
	emote?: boolean;
	buffer?: Buffer;
}

export class Client extends EventEmitter {
	private tox: Toxcore.Tox;
	private hexFriendLut: {[key: string]: number};
	private friendHexLut: {[key: number]: string};
	private friendsStatus: {[key: number]: boolean};
	private friendsMessageQueue: {[key: number]: IMessageQueueEntry[]};
	private files: {[key: string]: IToxFile};
	private avatarUrl: string = "";
	private avatarBuffer: Buffer;
	constructor(dataPath: string) {
		super();
		this.hexFriendLut = {};
		this.friendHexLut = {};
		this.friendsStatus = {};
		this.friendsMessageQueue = {};
		this.files = {};
		this.tox = new toxcore.Tox({
			data: dataPath,
			path: "lib/libtoxcore.so",
			crypto: "lib/libtoxcore.so",
		});
	}

	public async connect() {
		await this.bootstrap();

		this.tox.on("friendName", async (e) => {
			const key = await this.getFriendPublicKeyHex(e.friend());
			log.verbose(`Got new name from key ${key}`);
			this.emit("friendName", key);
		});

		this.tox.on("friendRequest", async (e) => {
			await this.tox.addFriendNoRequestAsync(e.publicKey());
		});

		this.tox.on("friendConnectionStatus", async (e) => {
			const friend = e.friend();
			const isConnected = e.isConnected();
			const key = await this.getFriendPublicKeyHex(friend);
			log.verbose(`User ${key} connection status changed to ${isConnected}`);
			this.friendsStatus[friend] = isConnected;
			if (isConnected) {
				// no await as we do this in the background
				// tslint:disable-next-line:no-floating-promises
				this.popMessageQueue(friend);
				// no need to await here, either
				// tslint:disable-next-line:no-floating-promises
				this.sendAvatarToFriend(friend);
			}
			this.emit("friendStatus", key, isConnected ? "online" : "offline");
		});

		this.tox.on("friendMessage", async (e) => {
			const key = await this.getFriendPublicKeyHex(e.friend());
			log.verbose(`Received new message from key ${key}`);
			this.emit("message", {
				id: key,
				message: e.message(),
				emote: e._messageType === Toxcore.Consts.TOX_MESSAGE_TYPE_ACTION,
			});
		});

		this.tox.on("friendStatus", async (e) => {
			const key = await this.getFriendPublicKeyHex(e.friend());
			let status = {
				0: "online",
				1: "away",
				2: "busy",
			}[e.status()];
			if (!status) {
				status = "online";
			}
			log.verbose(`User ${key} status changed to ${status}`);
			this.emit("friendStatus", key, status);
		});

		this.tox.on("friendStatusMessage", async (e) => {
			const key = await this.getFriendPublicKeyHex(e.friend());
			log.verbose(`User ${key} status message changed to ${e.statusMessage()}`);
			this.emit("friendStatusMessage", key, e.statusMessage());
		});

		this.tox.on("friendTyping", async (e) => {
			const key = await this.getFriendPublicKeyHex(e.friend());
			log.verbose(`User ${key} typing event to ${e.isTyping()}`);
			this.emit("friendTyping", key, e.isTyping());
		});

		this.tox.on("selfConnectionStatus", async (e) => {
			const status = e.isConnected() ? "connected" : "disconnected";
			log.verbose(`New connection status: ${status}!`);
			if (e.isConnected()) {
				await this.populateFriendList();
			}
			this.emit(status, await this.getFullPubKey());
			if (!e.isConnected()) {
				log.info(`Lost connection, reconnecting...`);
				try {
					await this.bootstrap();
					await this.tox.start();
				} catch (err) {
					log.error("Failed to start client", err);
				}
			}
		});

		// file transmission stuff
		this.tox.on("fileRecvControl", (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			log.verbose(`Received file control with key ${fileKey}: ${e.controlName()}`);

			if (e.isCancel()) {
				delete this.files[fileKey];
			}
		});

		this.tox.on("fileChunkRequest", async (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			const f = this.files[fileKey];
			if (!f) {
				return;
			}
			log.verbose(`Received file chunk request with key ${fileKey}`);
			const length = e.length();
			const position = e.position();
			const sendData = Buffer.alloc(length);
			f.buffer.copy(sendData, 0, position, position + length);
/*
			if (position + length > f.size) {
				sendData = sendData.slice(0, f.size - position);
			}
*/
			try {
				await this.tox.sendFileChunkAsync(e.friend(), e.file(), position, sendData);
			} catch (err) {
				if (err.code === Toxcore.Consts.TOX_ERR_FILE_SEND_CHUNK_NOT_TRANSFERRING) {
					log.verbose("Done sending file");
					delete this.files[fileKey];
				} else {
					throw err;
				}
			}
		});

		this.tox.on("fileRecv", async (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			this.files[fileKey] = {
				kind: e.kind() === Toxcore.Consts.TOX_FILE_KIND_AVATAR ? "avatar" : "data",
				size: e.size(),
				buffer: Buffer.alloc(e.size()),
				name: e.filename() || "tox_transfer",
			};
			await this.tox.controlFileAsync(e.friend(), e.file(), "resume");
		});

		this.tox.on("fileRecvChunk", async (e) => {
			const fileKey = `${e.friend()};${e.file()}`;
			log.verbose(`Received fileRecvChunk with key ${fileKey}`);
			const f = this.files[fileKey];

			if (e.isFinal()) {
				const key = await this.getFriendPublicKeyHex(e.friend());
				log.info(`Received file ${f.name} of kind ${f.kind} from ${key}`);
				// we are done! yay!
				if (f.kind === "avatar") {
					this.emit("friendAvatar", key, f);
				} else {
					this.emit("file", key, f);
				}
				delete this.files[fileKey];
				return;
			}
			e.data().copy(f.buffer, e.position(), 0, e.length());
		});

		await this.tox.start();
	}

	public async disconnect() {
		await this.tox.stop();
	}

	public async sendMessage(hex: string, text: string, emote: boolean) {
		const friend = await this.getHexFriendLut(hex);
		await this.sendMessageFriend(friend, text, emote);
	}

	public async sendFile(hex: string, buffer: Buffer, filename: string = "") {
		const friend = await this.getHexFriendLut(hex);
		await this.sendFileFriend(friend, buffer, filename);
	}

	public async getSelfUserId() {
		return await this.tox.getAddressHexAsyncAsync();
	}

	public async getNameById(hex: string): Promise<string> {
		const id = await this.getHexFriendLut(hex);
		const name = await this.tox.getFriendNameAsync(id);
		return name.replace(/\0/g, "");
	}

	public async setName(name: string) {
		log.verbose(`Setting name to ${name}`);
		await this.tox.setNameAsync(name);
	}

	public async setAvatar(url: string) {
		if (url === this.avatarUrl) {
			return;
		}
		log.verbose(`Setting avatar to ${url}`);
		this.avatarUrl = url;
		this.avatarBuffer = await Util.DownloadFile(url);
		// we do this async in the background
		// tslint:disable-next-line:no-floating-promises
		this.sendAvatarUpdate();
	}

	private async sendAvatarUpdate() {
		for (const f of Object.keys(this.friendsStatus)) {
			const friend = Number(f);
			if (!isNaN(friend) && this.friendsStatus[friend]) {
				// we do this async in the background
				// tslint:disable-next-line:no-floating-promises
				this.sendAvatarToFriend(friend);
			}
		}
	}

	private async sendAvatarToFriend(friend: number) {
		if (!this.avatarBuffer) {
			return;
		}
		const filename = "avatar";
		const buffer = this.avatarBuffer;
		const fileNum = await this.tox.sendFileAsync(friend, Toxcore.Consts.TOX_FILE_KIND_AVATAR,
			filename, buffer.byteLength);
		this.files[`${friend};${fileNum}`] = {
			name: filename,
			buffer,
			kind: "avatar",
			size: buffer.byteLength,
		};
	}

	private async sendMessageFriend(friend: number, text: string, emote: boolean) {
		try {
			await this.tox.sendFriendMessageAsync(friend, text, emote);
		} catch (err) {
			if (err.code !== Toxcore.Consts.TOX_ERR_FRIEND_SEND_MESSAGE_FRIEND_NOT_CONNECTED || this.isFriendConnected(friend)) {
				throw err;
			}
			log.info(`Friend ${friend} offline, appending message to queue`);
			if (!this.friendsMessageQueue[friend]) {
				this.friendsMessageQueue[friend] = [];
			}
			this.friendsMessageQueue[friend].push({
				type: "text",
				text,
				emote,
			});
		}
	}

	private async sendFileFriend(friend: number, buffer: Buffer, filename: string = "") {
		try {
			const fileNum = await this.tox.sendFileAsync(friend, Toxcore.Consts.TOX_FILE_KIND_DATA, filename, buffer.byteLength);
			this.files[`${friend};${fileNum}`] = {
				name: filename,
				buffer,
				kind: "data",
				size: buffer.byteLength,
			};
		} catch (err) {
			if (err.code !== Toxcore.Consts.TOX_ERR_FILE_SEND_FRIEND_NOT_CONNECTED || this.isFriendConnected(friend)) {
				throw err;
			}
			log.info(`Friend ${friend} offline, appending file to queue`);
			if (!this.friendsMessageQueue[friend]) {
				this.friendsMessageQueue[friend] = [];
			}
			this.friendsMessageQueue[friend].push({
				type: "file",
				text: filename,
				buffer,
			});
		}
	}

	private async getHexFriendLut(hex: string): Promise<number> {
		if (this.hexFriendLut[hex] !== undefined) {
			return this.hexFriendLut[hex];
		}
		await this.populateFriendList();
		return this.hexFriendLut[hex];
	}

	private async populateFriendList() {
		const friends = await this.tox.getFriendListAsync();
		log.verbose(`Received friends list: ${friends}`);
		for (const f of friends) {
			const hex = await this.getFriendPublicKeyHex(f);
			this.hexFriendLut[hex] = f;
		}
	}

	private async getFriendPublicKeyHex(f: number): Promise<string> {
		if (this.friendHexLut[f]) {
			return this.friendHexLut[f];
		}
		this.friendHexLut[f] = await this.tox.getFriendPublicKeyHexAsync(f);
		return this.friendHexLut[f];
	}

	private isFriendConnected(friend: number): boolean {
		if (!this.friendsStatus[friend]) {
			return false;
		}
		return this.friendsStatus[friend];
	}

	private async popMessageQueue(friend: number) {
		log.info(`Popping message queue for friend ${friend}...`);
		if (!this.friendsMessageQueue[friend]) {
			log.verbose("Queue empty!");
			return; //  nothing to do
		}
		let item: IMessageQueueEntry | undefined;
		item = this.friendsMessageQueue[friend].shift();
		while (item) {
			if (item.type === "text") {
				await this.sendMessageFriend(friend, item.text!, item.emote!);
			} else if (item.type === "file") {
				await this.sendFileFriend(friend, item.buffer!, item.text!);
			}
			item = this.friendsMessageQueue[friend].shift();
		}
	}

	private async getFullPubKey(): Promise<string> {
		// tslint:disable:no-bitwise no-magic-numbers
		let key = await this.tox.getPublicKeyAsync();
		const nospam = Buffer.alloc(4);
		nospam.writeUInt32BE(await this.tox.getNospamAsync(), 0);
		key = Buffer.concat([key, nospam]);

		const checksum = Buffer.alloc(2);
		checksum.writeUInt16BE(0, 0);
		for (let i = 0; i < key.byteLength; i += 2) {
			checksum[0] ^= key[i];
			checksum[1] ^= key[i + 1];
		}

		key = Buffer.concat([key, checksum]);
		return key.toString("hex");
		// tslint:enable:no-bitwise no-magic-numbers
	}

	private async bootstrap() {
		for (const node of nodes) {
			await this.tox.bootstrap(node.address, node.port, node.key);
		}
	}
}
