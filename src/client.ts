import { Log } from "mx-puppet-bridge";
import { EventEmitter } from "events";
import * as Bluebird from "bluebird";
import * as Toxcore from "js-toxcore-c";
const toxcore = Bluebird.promisifyAll(Toxcore);


const log = new Log("ToxPuppet:Client");

const nodes = [
  { maintainer: 'saneki',
    address: '96.31.85.154',
    port: 33445,
    key: '674153CF49616CD1C4ADF44B004686FC1F6C9DCDD048EF89B117B3F02AA0B778' },
  { maintainer: 'Impyy',
    address: '178.62.250.138',
    port: 33445,
    key: '788236D34978D1D5BD822F0A5BEBD2C53C64CC31CD3149350EE27D4D9A2F9B6B' },
  { maintainer: 'sonOfRa',
    address: '144.76.60.215',
    port: 33445,
    key: '04119E835DF3E78BACF0F84235B300546AF8B936F035185E2A8E9E0A67C8924F' }
];

export class Client extends EventEmitter {
	private tox: Toxcore.Tox;
	private hexFriendLut: {[key: string]: number};
	private friendHexLut: {[key: number]: string};
	constructor(dataPath: string) {
		super();
		this.hexFriendLut = {};
		this.friendHexLut = {};
		this.tox = new toxcore.Tox({
			data: dataPath,
			path: "lib/libtoxcore.so",
			crypto: "lib/libtoxcore.so",
		});
	}

	public async connect() {
		for (const node of nodes) {
			await this.tox.bootstrap(node.address, node.port, node.key);
		}

		this.tox.on("friendMessage", async (e) => {
			this.emit("message", {
				id: await this.getFriendPublicKeyHex(e.friend()),
				message: e.message(),
				emote: e._messageType === 1,
			});
		});

		this.tox.on("friendStatus", async (e) => {
			this.emit("status", {
				id: await this.getFriendPublicKeyHex(e.friend()),
				status: e.status,
			});
		});

		this.tox.on("selfConnectionStatus", async (e) => {
			const status = e.isConnected() ? "connected" : "disconnected";
			log.verbose(`New connection status: ${status}!`);
			if (e.isConnected()) {
				await this.populateFriendList();
			}
			this.emit(status);
		})

		await this.tox.start();
	}

	public async disconnect() {
		await this.tox.stop();
	}

	public async sendMessage(hex: string, text: string, emote: boolean) {
		const channel = await this.getHexFriendLut(hex);
		await this.tox.sendFriendMessageAsync(channel, text, emote);
	}

	public async getSelfUserId() {
		return await this.tox.getAddressHexAsyncAsync();
	}

	public async getNameById(hex: string): Promise<string> {
		const id = await this.getHexFriendLut(hex);
		const name = await this.tox.getFriendNameAsync(id);
		return name.replace(/\0/g, "");
	}

	private async getHexFriendLut(hex: string): Promise<number> {
		if (this.hexFriendLut[hex]) {
			return this.hexFriendLut[hex];
		}
		this.populateFriendList();
		return this.populateFriendList[hex];
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
}
