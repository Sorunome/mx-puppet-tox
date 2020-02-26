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
	IPuppetBridgeRegOpts,
	Log,
	IRetData,
	Util,
	IProtocolInformation,
} from "mx-puppet-bridge";
import * as commandLineArgs from "command-line-args";
import * as commandLineUsage from "command-line-usage";
import { Tox } from "./tox";
import { IBootstrapNode, CreateSave } from "./client";
import * as fs from "fs";
import { ToxConfigWrap } from "./config";
import * as yaml from "js-yaml";
import { DefaultNodes } from "./defaultnodes";

const log = new Log("ToxPuppet:index");

const commandOptions = [
	{ name: "register", alias: "r", type: Boolean },
	{ name: "registration-file", alias: "f", type: String },
	{ name: "config", alias: "c", type: String },
	{ name: "help", alias: "h", type: Boolean },
];
const options = Object.assign({
	"register": false,
	"registration-file": "tox-registration.yaml",
	"config": "config.yaml",
	"help": false,
}, commandLineArgs(commandOptions));

if (options.help) {
	// tslint:disable-next-line:no-console
	console.log(commandLineUsage([
		{
			header: "Matrix Tox Puppet Bridge",
			content: "A matrix puppet bridge for tox",
		},
		{
			header: "Options",
			optionList: commandOptions,
		},
	]));
	process.exit(0);
}

const protocol = {
	features: {
		file: true, // no need for the others as we auto-detect types anyways
		presence: true, // we want to be able to send presence
	},
	id: "tox",
	displayname: "Tox",
	externalUrl: "https://tox.chat/",
} as IProtocolInformation;

const puppet = new PuppetBridge(options["registration-file"], options.config, protocol);

if (options.register) {
	// okay, all we have to do is generate a registration file
	puppet.readConfig();
	try {
		puppet.generateRegistration({
			prefix: "_toxpuppet_",
			id: "tox-puppet",
			url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
		} as IPuppetBridgeRegOpts);
	} catch (err) {
		// tslint:disable-next-line:no-console
		console.log("Couldn't generate registration file:", err);
	}
	process.exit(0);
}

let config: ToxConfigWrap = new ToxConfigWrap();

function readConfig() {
	config = new ToxConfigWrap();
	config.applyConfig(yaml.safeLoad(fs.readFileSync(options.config)));
}

export function Config(): ToxConfigWrap {
	return config;
}

async function updateBootstrapNodes() {
	let currentNodes: IBootstrapNode[] = [];
	try {
		const currentNodesData = fs.readFileSync(Config().tox.nodesFile).toString("utf-8");
		currentNodes = JSON.parse(currentNodesData);
	} catch (err) {
		log.warn("Current bootstrap nodes file is invalid json, using blank one", err);
		currentNodes = DefaultNodes;
	}
	let newNodesData: any = {};
	try {
		const str = (await Util.DownloadFile("https://nodes.tox.chat/json")).toString("utf-8");
		newNodesData = JSON.parse(str);
	} catch (err) {
		log.warn("Unable to fetch node bootstrap list, doing nothing", err);
		return;
	}
	if (!newNodesData.nodes) {
		log.warn("fetched nodes data isn't an array, doing nothing");
		return;
	}
	for (const node of newNodesData.nodes) {
		const index = currentNodes.findIndex((n) => n.key === node.public_key);
		const nodeData = {
			key: node.public_key,
			port: node.port,
			address: node.ipv4,
			maintainer: node.maintainer,
		} as IBootstrapNode;
		if (index !== -1) {
			currentNodes[index] = nodeData;
		} else {
			currentNodes.push(nodeData);
		}
	}
	try {
		fs.writeFileSync(Config().tox.nodesFile, JSON.stringify(currentNodes));
	} catch (err) {
		log.error("Unable to write new nodes file", err);
	}
}

async function run() {
	await puppet.init();
	readConfig();
	await updateBootstrapNodes();
	const tox = new Tox(puppet);
	puppet.on("puppetNew", tox.newPuppet.bind(tox));
	puppet.on("puppetDelete", tox.deletePuppet.bind(tox));
	puppet.on("message", tox.handleMatrixMessage.bind(tox));
	puppet.on("file", tox.handleMatrixFile.bind(tox));
	puppet.on("puppetName", tox.handlePuppetName.bind(tox));
	puppet.on("puppetAvatar", tox.handlePuppetAvatar.bind(tox));
	puppet.setCreateUserHook(tox.createUser.bind(tox));
	puppet.setCreateRoomHook(tox.createRoom.bind(tox));
	puppet.setGetDmRoomIdHook(tox.getDmRoom.bind(tox));
	puppet.setListUsersHook(tox.listUsers.bind(tox));
	puppet.setGetDescHook(async (puppetId: number, data: any): Promise<string> => {
		let s = "Tox";
		if (data.name) {
			s += ` ${data.name}`;
		}
		if (data.showpath) {
			s += ` savefile \`${data.showpath}\``;
		}
		if (data.key) {
			s += `with public key \`${data.key}\``;
		}
		return s;
	});
	puppet.setGetDataFromStrHook(async (str: string): Promise<IRetData> => {
		const retData = {
			success: false,
		} as IRetData;
		if (!str) {
			retData.error = "Please specify a name!";
			return retData;
		}
		str = str.trim();
		let path = "";
		let fileExists = false;
		if (Config().tox.allowFullSavePath) {
			const parts = str.split(" ");
			if (parts[0] === "file") {
				str = "file";
				parts.shift();
				path = parts.join(" ");
				fileExists = true;
			}
		}
		if (!str.match(/^[a-zA-Z0-9]+$/)) {
			retData.error = "Name may only contain numbers and letters!";
			return retData;
		}
		let showpath = path;
		if (!path) {
			showpath = `${str}.${new Date().getTime()}.tox`;
			path = `${Config().tox.savesFolder}/${showpath}`;
		}
		if (!fileExists) {
			try {
				await CreateSave(path);
			} catch (err) {
				retData.error = "Failed to create save file, please contact an administrator!";
				log.error("Failed to create savefile", err);
				return retData;
			}
		}
		retData.success = true;
		retData.data = {
			name: str,
			savefile: path,
			showpath,
		};
		return retData;
	});
	puppet.setBotHeaderMsgHook((): string => {
		return "Tox Puppet Bridge";
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run();
