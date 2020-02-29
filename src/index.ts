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
import { Tox, IToxPuppetData } from "./tox";
import * as fs from "fs";
import { ToxConfigWrap } from "./config";
import * as yaml from "js-yaml";
import { Util as ToxUtil, Logger } from "maybe-a-tox-client";

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

function registerLogging() {
	const logMap = new Map<string, Log>();
	const getLogFunc = (level: string) => {
		// tslint:disable-next-line no-any
		return (mod: string, args: any[]) => {
			mod = "ToxClient:" + mod;
			let logger = logMap.get(mod);
			if (!logger) {
				logger = new Log(mod);
				logMap.set(mod, logger);
			}
			logger[level](...args);
		};
	};
	Logger.setLogger({
		silly: getLogFunc("silly"),
		debug: getLogFunc("debug"),
		verbose: getLogFunc("verbose"),
		info: getLogFunc("info"),
		warn: getLogFunc("warn"),
		error: getLogFunc("error"),
	});
}

export function Config(): ToxConfigWrap {
	return config;
}

async function run() {
	registerLogging();
	await puppet.init();
	readConfig();
	await ToxUtil.UpdateBootstrapNodesFile(Config().tox.nodesFile);
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
	puppet.setGetDescHook(async (puppetId: number, data: IToxPuppetData): Promise<string> => {
		let s = "Tox";
		if (data.name) {
			s += ` ${data.name}`;
		}
		if (data.key) {
			s += ` with full key \`${data.key}\``;
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
				await ToxUtil.CreateSave(path, Config().tox.toxcore);
			} catch (err) {
				retData.error = "Failed to create save file, please contact an administrator!";
				log.error("Failed to create savefile", err);
				return retData;
			}
		}
		retData.success = true;
		const data: IToxPuppetData = {
			name: str,
			savefile: path,
			showpath,
		};
		retData.data = data;
		return retData;
	});
	puppet.setBotHeaderMsgHook((): string => {
		return "Tox Puppet Bridge";
	});
	puppet.registerCommand("acceptfriend", {
		fn: tox.commandAcceptFriend.bind(tox),
		help: `Accept an incoming friends request.

Usage: \`acceptfriend <puppetId> <key>\``,
	});
	puppet.registerCommand("addfriend", {
		fn: tox.commandAddFriend.bind(tox),
		help: `Adds a new friend. Adding a message is optional

Usage: \`addfriend <puppetId> <key> <message>\``,
	});
	puppet.registerCommand("removefriend", {
		fn: tox.commandRemoveFriend.bind(tox),
		help: `Removes a friend.

Usage: \`removefriend <puppetId> <key>\``,
	});
	await puppet.start();
}

// tslint:disable-next-line:no-floating-promises
run();
