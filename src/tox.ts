import {
	PuppetBridge,
	IRemoteUserReceive,
	IReceiveParams,
	IRemoteChanSend,
	IMessageEvent,
	IFileEvent,
	Log,
	Util,
} from "mx-puppet-bridge";
import { Client, IToxFile } from "./client";

const log = new Log("ToxPuppet:tox");

interface IToxPuppets {
	[puppetId: number]: {
		client: Client;
		data: any;
		clientStopped: boolean;
	}
}

export class Tox {
	private puppets: IToxPuppets = {};
	constructor (
		private puppet: PuppetBridge,
	) { }

	public async getUserParams(puppetId: number, hex: string): Promise<IRemoteUserReceive | null> {
		if (!this.puppets[puppetId]) {
			return null;
		}
		return {
			userId: hex,
			name: await this.puppets[puppetId].client.getNameById(hex),
		} as IRemoteUserReceive;
	}

	public getSendParams(puppetId: number, hex: string): IReceiveParams {
		return {
			chan: {
				roomId: hex,
				puppetId,
			},
			user: {
				userId: hex,
			},
		} as IReceiveParams;
	}

	public async removePuppet(puppetId: number) {
		log.info(`Removing puppet: puppetId=${puppetId}`);
		delete this.puppets[puppetId];
	}

	public async stopClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		p.clientStopped = true;
		await p.client.disconnect();
	}

	public async startClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const client = new Client(p.data.savefile);
		client.on("connected", async (key: string) => {
			const d = this.puppets[puppetId].data;
			d.key = key;
			await this.puppet.setPuppetData(puppetId, d);
		});
		client.on("disconnected", async () => {
			if (p.clientStopped) {
				return;
			}
			log.info(`Lost connection for puppet ${puppetId}, reconnecting in a minute...`);
			await Util.sleep(60 * 1000);
			try {
				await this.startClient(puppetId);
			} catch (err) {
				log.warn("Failed to restart client", err);
			}
		});
		client.on("message", async (data) => {
			log.verbose("Got new message event");
			await this.handleToxMessage(puppetId, data);
		});
		client.on("file", async (key, data) => {
			log.verbose("Got new file event");
			await this.handleToxFile(puppetId, key, data);
		});
		client.on("friendAvatar", async (key, data) => {
			log.verbose(`Updating avatar for ${key}...`);
			let user = await this.getUserParams(puppetId, key);
			user.avatarBuffer = data.buffer;
			await this.puppet.updateUser(user);
		});
		client.on("friendName", async (key) => {
			await this.updateUser(puppetId, key);
		});
		p.client = client;
		try {
			await client.connect();
		} catch (err) {
			log.warn("Failed to connect client", err);
			throw err;
		}
	}

	public async handleToxMessage(puppetId: number, data: any) {
		const params = this.getSendParams(puppetId, data.id);
		await this.puppet.sendMessage(params, {
			body: data.message,
			emote: data.emote,
		});
	}

	public async handleToxFile(puppetId: number, key: string, data: IToxFile) {
		const params = this.getSendParams(puppetId, key);
		await this.puppet.sendFileDetect(params, data.buffer, data.name);
	}

	public async handleMatrixMessage(room: IRemoteChanSend, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		await p.client.sendMessage(room.roomId, data.body, data.emote);
	}

	public async handleMatrixFile(room: IRemoteChanSend, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const buffer = await Util.DownloadFile(data.url);
		await p.client.sendFile(room.roomId, buffer, data.filename);
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.removePuppet(puppetId);
		}
		const client = new Client(data.savefile);
		this.puppets[puppetId] = {
			client,
			data,
			clientStopped: false,
		} as any;
		await this.startClient(puppetId);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		await this.stopClient(puppetId);
		await this.removePuppet(puppetId);
	}

	public async updateUser(puppetId: number, hex: string) {
		const user = await this.getUserParams(puppetId, hex);
		log.verbose(`Update user data`, user);
		if (!user) {
			return;
		}
		await this.puppet.updateUser(user);
	}
}
