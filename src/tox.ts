/*
Copyright 2019, 2020 mx-puppet-tox
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
	PuppetBridge,
	IRemoteUser,
	IReceiveParams,
	IRemoteRoom,
	IMessageEvent,
	IFileEvent,
	Log,
	Util,
	IRetList,
	IPuppetData,
} from "mx-puppet-bridge";
import { Client, IToxMessage, IToxFile } from "./client";

const log = new Log("ToxPuppet:tox");

export interface IToxPuppetData extends IPuppetData {
	name: string;
	savefile: string;
	showpath: string;
	key?: string;
}

interface IToxPuppet {
	client: Client;
	data: IToxPuppetData;
}

interface IToxPuppets {
	[puppetId: number]: IToxPuppet;
}

export class Tox {
	private puppets: IToxPuppets = {};
	constructor(
		private puppet: PuppetBridge,
	) { }

	public async getUserParams(puppetId: number, hex: string): Promise<IRemoteUser | null> {
		if (!this.puppets[puppetId]) {
			return null;
		}
		const name = await this.puppets[puppetId].client.getNameById(hex);
		if (!name) {
			return null;
		}
		return {
			userId: hex,
			puppetId,
			name,
		} as IRemoteUser;
	}

	public getSendParams(puppetId: number, hex: string): IReceiveParams {
		return {
			room: {
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
		p.client = client;
		const userInfo = await this.puppet.getPuppetMxidInfo(puppetId);
		if (userInfo) {
			if (userInfo.name) {
				await client.setName(userInfo.name);
			}
			if (userInfo.avatarUrl) {
				await this.handlePuppetAvatar(puppetId, userInfo.avatarUrl, userInfo.avatarMxc as string);
			}
		}
		client.on("connected", async (key: string) => {
			try {
				log.verbose("Got connected event");
				const d = this.puppets[puppetId].data;
				d.key = key;
				await this.puppet.setPuppetData(puppetId, d);
				await this.puppet.sendStatusMessage(puppetId, "connected");
			} catch (err) {
				log.error("Error handling tox connected event", err.error || err.body || err);
			}
		});
		client.on("disconnected", async (key: string) => {
			try {
				log.verbose("Got disconnected event");
				await this.puppet.sendStatusMessage(puppetId, "disconnected");
			} catch (err) {
				log.error("Error handling tox disconnected event", err.error || err.body || err);
			}
		});
		client.on("message", async (data) => {
			try {
				log.verbose("Got new message event");
				await this.handleToxMessage(puppetId, data);
			} catch (err) {
				log.error("Error handling tox message event", err.error || err.body || err);
			}
		});
		client.on("file", async (key, data) => {
			try {
				log.verbose("Got new file event");
				await this.handleToxFile(puppetId, key, data);
			} catch (err) {
				log.error("Error handling tox file event", err.error || err.body || err);
			}
		});
		client.on("friendAvatar", async (key, data) => {
			try {
				log.verbose(`Updating avatar for ${key}...`);
				const user = await this.getUserParams(puppetId, key);
				user!.avatarBuffer = data.buffer;
				await this.puppet.updateUser(user!);
			} catch (err) {
				log.error("Error handling tox friendAvatar event", err.error || err.body || err);
			}
		});
		client.on("friendName", async (key) => {
			try {
				await this.updateUser(puppetId, key);
			} catch (err) {
				log.error("Error handling tox friendName event", err.error || err.body || err);
			}
		});
		client.on("friendStatus", async (key, status) => {
			try {
				const matrixPresence = {
					online: "online",
					offline: "offline",
					away: "unavailable",
					busy: "unavailable",
				}[status];
				const user = this.getSendParams(puppetId, key).user;
				await this.puppet.setUserPresence(user, matrixPresence);
			} catch (err) {
				log.error("Error handling tox friendStatus event", err.error || err.body || err);
			}
		});
		client.on("friendStatusMessage", async (key, msg) => {
			try {
				const user = this.getSendParams(puppetId, key).user;
				await this.puppet.setUserStatus(user, msg);
			} catch (err) {
				log.error("Error handling tox friendStatusMessage event", err.error || err.body || err);
			}
		});
		client.on("friendTyping", async (key, typing) => {
			try {
				const params = this.getSendParams(puppetId, key);
				await this.puppet.setUserTyping(params, typing);
			} catch (err) {
				log.error("Error handling tox friendTyping event", err.error || err.body || err);
			}
		});
		try {
			await client.connect();
		} catch (err) {
			log.warn("Failed to connect client", err);
			await this.puppet.sendStatusMessage(puppetId, `Failed to connect client: ${err}`);
			throw err;
		}
	}

	public async handleToxMessage(puppetId: number, data: IToxMessage) {
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

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		await p.client.sendMessage(room.roomId, data.body, Boolean(data.emote));
	}

	public async handleMatrixFile(room: IRemoteRoom, data: IFileEvent) {
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
		url = url.replace("download", "thumbnail") + "?width=800&height=800";
		await p.client.setAvatar(url);
	}

	public async newPuppet(puppetId: number, data: IToxPuppetData) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.removePuppet(puppetId);
		}
		const client = new Client(data.savefile);
		this.puppets[puppetId] = {
			client,
			data,
		} as IToxPuppet;
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

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		return await this.getUserParams(user.puppetId, user.userId);
	}

	public async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const user = await this.getUserParams(room.puppetId, room.roomId);
		if (!user) {
			return null;
		}
		return this.getSendParams(room.puppetId, room.roomId).room;
	}

	public async getDmRoom(user: IRemoteUser): Promise<string | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const roomId = await p.client.getRoomForUser(user.userId);
		if (!roomId) {
			return null;
		}
		return roomId;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		return await p.client.listUsers();
	}
}
