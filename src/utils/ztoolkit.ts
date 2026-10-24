import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

class ReadAlongToolkit extends BasicTool {
  unregisterAll() {
    unregister(this);
  }
}

function createZToolkit() {
  const _ztoolkit = new ReadAlongToolkit();
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = __env__ === "production";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  return _ztoolkit;
}
