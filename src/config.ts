export class ToxConfigWrap {
	public tox: ToxConfig = new ToxConfig();

	public applyConfig(newConfig: {[key: string]: any}, configLayer: {[key: string]: any} = this) {
		Object.keys(newConfig).forEach((key) => {
			if (configLayer[key] instanceof Object && !(configLayer[key] instanceof Array)) {
				this.applyConfig(newConfig[key], configLayer[key]);
			} else {
				configLayer[key] = newConfig[key];
			}
		});
	}
}

class ToxConfig {
	public nodesFile: string = "nodes.json";
	public toxcore: string = "lib/libtoxcore.so";
	public savesFolder: string = "toxsaves";
	public allowFullSavePath: boolean = false;
}
