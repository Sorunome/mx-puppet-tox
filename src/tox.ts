import {
	PuppetBridge,
	IRemoteUser,
	IReceiveParams,
	IRemoteChan,
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
	}
}

export class Tox {
	private puppets: IToxPuppets = {};
	constructor (
		private puppet: PuppetBridge,
	) { }

	public async getUserParams(puppetId: number, hex: string): Promise<IRemoteUser | null> {
		if (!this.puppets[puppetId]) {
			return null;
		}
		return {
			userId: hex,
			puppetId,
			name: await this.puppets[puppetId].client.getNameById(hex),
		} as IRemoteUser;
	}

	public getSendParams(puppetId: number, hex: string): IReceiveParams {
		return {
			chan: {
				roomId: hex,
				puppetId,
				isDirect: true,
			},
			user: {
				userId: hex,
				puppetId,
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
		await p.client.disconnect();
	}

	public async startClient(puppetId: number) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		const client = new Client(p.data.savefile);
		const userInfo = await this.puppet.getPuppetMxidInfo(puppetId);
		if (userInfo) {
			if (userInfo.name) {
				await client.setName(userInfo.name);
			}
			if (userInfo.avatarUrl) {
				await client.setAvatar(userInfo.avatarUrl);
			}
		}
		client.on("connected", async (key: string) => {
			const d = this.puppets[puppetId].data;
			d.key = key;
			await this.puppet.setPuppetData(puppetId, d);
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
		client.on("friendStatus", async (key, status) => {
			const matrixPresence = {
				online: "online",
				offline: "offline",
				away: "unavailable",
				busy: "unavailable",
			}[status];
			const user = this.getSendParams(puppetId, key).user;
			await this.puppet.setUserPresence(user, matrixPresence);
		});
		client.on("friendStatusMessage", async (key, msg) => {
			const user = this.getSendParams(puppetId, key).user;
			await this.puppet.setUserStatus(user, msg);
		});
		client.on("friendTyping", async (key, typing) => {
			const params = this.getSendParams(puppetId, key);
			await this.puppet.setUserTyping(params, typing);
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

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		await p.client.sendMessage(room.roomId, data.body, data.emote);
	}

	public async handleMatrixFile(room: IRemoteChan, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const buffer = await Util.DownloadFile(data.url);
		await p.client.sendFile(room.roomId, buffer, data.filename);
	}

	public async handlePuppetName(puppetId: number, name: string) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		await p.client.setName(name);
	}

	public async handlePuppetAvatar(puppetId: number, url: string, mxc: string) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		await p.client.setAvatar(url);
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
