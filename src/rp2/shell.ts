/*
Shell is something that's started and stopped, rather than being there 
all the time. It puts the mode into Raw REPL when it's instantiated, and 
puts it back in Friendly REPL when it's closed down.

In Raw REPL, you can enter multiple commands separated by line breaks, 
and when you press `Ctrl+D` it will execute that code, initially 
acknowledging with `OK`, giving any output and then returning a Raw REPL
`>` prompt.

It's also possible to run a block of code in Raw REPL by using the
`board.run()` method. This switches to Raw REPL, runs the code by sending 
`Ctrl+D`, grabs the response and puts the console back into Friendly REPL.

Friendly REPL is the default mode so the user can type things via the UI.
*/

import Logger from '../logger';
import ApiWrapper from '../apiWrapper';
import Utils from '../utils';
import Config, { Constants } from '../config';
import * as path from 'path';
import FileWriter from './fileWriter';
import { createDeflate } from 'zlib';
import { pipeline } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { promisify } from 'util';
import SettingsWrapper, { SettingsKey } from '../settingsWrapper';
import Pyboard from './pyboard';

const pipe = promisify(pipeline);

export default class Shell {
  public config: Constants;
  private settings: SettingsWrapper;
  private eof: string = '\x04'; // reset (ctrl-d)
  private retries: number = 2;
  private board: Pyboard;
  private api: ApiWrapper;
  private logger: Logger;
  private utils: Utils;
  public mcuRootFolder: string;
  private working: boolean;
  private interruptCb: Function | null;
  private interrupted: boolean;
  private binChunkSize: number;

  constructor(board: Pyboard, settings: SettingsWrapper) {
    this.config = Config.constants();
    this.settings = settings;
    this.binChunkSize = this.settings.uploadChunkSize;
    this.board = board;
    this.api = new ApiWrapper();
    this.logger = new Logger('Shell');
    this.utils = new Utils(settings);
    this.mcuRootFolder = '/';
    this.working = false;
    this.interruptCb = null;
    this.interrupted = false;
  }

  public async initialise() {
    this.logger.silly('Try to enter raw mode');

    // 3 = RAW_REPL
    if (this.board.status !== 3) {
      await this.board.enterRawReplNoReset();
    }
  }

  public async getFreeSpace() {
    let command =
      'import uos, usys\r\n' +
      "_s = uos.statvfs('" +
      this.mcuRootFolder +
      "')\r\n" +
      'usys.stdout.write(str(s[0]*s[3])\r\n' +
      'del(_s)\r\n';

    return await this.board.sendWait(command);
  }

  public async decompress(name: string) {
    let command =
      'import uzlib\r\n' +
      'def decompress(name):\r\n' +
      "  with open(name,'rb+') as d:\r\n" +
      '    c = uzlib.decompress(d.read())\r\n' +
      "  with open(name,'wb') as d:\r\n" +
      '      d.write(c)\r\n' +
      '  del(c)\r\n' +
      "decompress('" +
      name +
      "')\r\n";

    return await this.board.sendWait(command, null, 40000);
  }

  public async compress(filepath: string, name: string) {
    let deflator = createDeflate({
      level: 2,
    });
    let source = createReadStream(filepath);
    let destination = createWriteStream(name);
    await pipe(source, deflator, destination);
  }

  public async writeFile(name: string, filePath: string | null, contents: any) {
    let fw = new FileWriter(this, this.board, this.settings, this.api);
    await fw.writeFileContent(name, filePath, contents, 0);
  }

  public async ensureDirectory(fullPath: string) {
    if (fullPath === undefined || fullPath === null) {
      return;
    }

    let parts = fullPath.split(path.sep);

    // Remove filename
    parts.pop();

    if (parts.length === 0) {
      return;
    }

    let command =
      'import uos\r\n' +
      'def ensureFolder(folder):\r\n' +
      '   try:\r\n' +
      '     uos.mkdir(folder)\r\n' +
      '   except OSError:\r\n' +
      '     ...\r\n' +
      '\r\n';

    for (let i = 1; i <= parts.length; i++) {
      command += `ensureFolder("${parts.slice(0, i).join('/')}")\r\n`;
    }

    await this.board.sendWait(command, null, 30000);
  }

  public async readFile(name: string) {
    this.working = true;

    // avoid leaking file handles
    let command =
      'import ubinascii,usys' +
      '\r\n' +
      "with open('" +
      name +
      "', 'rb') as f:" +
      '\r\n' +
      '  while True:' +
      '\r\n' +
      '    c = ubinascii.b2a_base64(f.read(' +
      this.binChunkSize +
      '))' +
      '\r\n' +
      '    usys.stdout.write(c)' +
      '\r\n' +
      "    if not len(c) or c == b'\\n':" +
      '\r\n' +
      '        break\r\n';

    let content = await this.board.sendWait(command, null, 60000);

    // Workaround for the "OK" return of soft reset, which is sometimes returned with the content
    if (content.indexOf('OK') === 0) {
      content = content.slice(2, content.length);
    }
    // Did an error occur
    if (content.includes('Traceback (')) {
      // some type of error
      this.logger.silly('Traceback error reading file contents: ' + content);
      // pass the error back
      throw content;
    }

    let decodeResult: any = this.utils.base64decode(
      content.replace(/[\r\n]/g, '')
    );
    // may cause problemms with the type of decodeResult and waht concat accepts as param
    let contentBuffer = Buffer.concat(decodeResult[1]);
    let contentStr = decodeResult[0].toString();

    this.working = false;

    return {
      buffer: contentBuffer,
      str: contentStr,
    };
  }

  public async list(
    root: string,
    recursive: boolean = false,
    hash: boolean = false
  ): Promise<any> {
    let toPythonBoolean = (value: boolean) => (value ? 'True' : 'False');

    // Based on code by Jos Verlinde:
    // https://gist.github.com/Josverl/a6f6be74e5193a8145e351ff9439ae3e
    let command =
      '# get file and folder information and return this as JSON\r\n' +
      '# params : folder , traverse subdirectory , output format, gethash\r\n' +
      '# intended to allow simple processing of files\r\n' +
      '# jos_verlinde@hotmail.com\r\n' +
      'import os, json\r\n' +
      'import uhashlib, ubinascii\r\n' +
      '\r\n' +
      'def listdir(path=".",sub=False,JSON=True,gethash=False):\r\n' +
      '    #Lists the file information of a folder\r\n' +
      '    li=[]\r\n' +
      '    if path==".": #Get current folder name\r\n' +
      '        path=os.getcwd()\r\n' +
      '    files = os.listdir(path)\r\n' +
      '    for file in files:\r\n' +
      '        #get size of each file \r\n' +
      '        info = {"Path": path, "Name": file, "Size": 0}\r\n' +
      '        if path[-1]=="/":\r\n' +
      '            full = "%s%s" % (path, file)\r\n' +
      '        else:\r\n' +
      '            full = "%s/%s" % (path, file)\r\n' +
      '        subdir = []\r\n' +
      '        try:\r\n' +
      '            stat = os.stat(full)\r\n' +
      '            if stat[0] & 0x4000:  # stat.S_IFDIR\r\n' +
      '                info["Type"] = "dir"\r\n' +
      '                #recurse folder(s)\r\n' +
      '                if sub == True:\r\n' +
      '                    subdir = listdir(path=full,sub=True,JSON=False)\r\n' +
      '            else:\r\n' +
      '                info["Size"] = stat[6]\r\n' +
      '                info["Type"] = "file"\r\n' +
      '                if(gethash):\r\n' +
      '                    with open(full, "rb") as f:\r\n' +
      '                        h = uhashlib.sha256(f.read())\r\n' +
      '                        info["Hash"] = ubinascii.hexlify(h.digest())\r\n' +
      '        except OSError as e:\r\n' +
      '            info["OSError"] = e.args[0]\r\n' +
      '            info["Type"] = "OSError"\r\n' +
      '        info["Fullname"]=full\r\n' +
      '        li.append(info)\r\n' +
      '        #recurse folder(s)\r\n' +
      '        if sub == True: \r\n' +
      '            li = li + subdir\r\n' +
      '    if JSON==True:\r\n' +
      '        return json.dumps(li)\r\n' +
      '    else: \r\n' +
      '        return li\r\n' +
      '\r\n' +
      `print(listdir("${root}", ${toPythonBoolean(
        recursive
      )}, True, ${toPythonBoolean(hash)}))`;

    let raw = await this.board.sendWait(command, null, 10000);
    return JSON.parse(raw);
  }

  public async removeFile(name: string) {
    let command = 'import uos\r\n' + "uos.remove('" + name + "')\r\n";

    await this.board.sendWait(command);
  }

  public async renameFile(oldName: string, newName: string) {
    let command =
      'import uos\r\n' + "uos.rename('" + oldName + "', '" + newName + "')\r\n";

    await this.board.sendWait(command);
  }

  public async createDir(name: string) {
    let command = 'import uos\r\n' + "uos.mkdir('" + name + "')\r\n";
    await this.board.sendWait(command);
  }

  public async changeDir(name: string) {
    let command = 'import uos\r\n' + "uos.chdir('" + name + "')\r\n";
    await this.board.sendWait(command);
  }

  public async removeDir(name: string) {
    let command = 'import uos\r\n' + "uos.rmdir('" + name + "')\r\n";
    await this.board.sendWait(command);
  }

  public async reset() {
    let command = 'import machine\r\n' + 'machine.reset()\r\n';

    await this.board.send(command);
    await this.board.send(this.eof, false); // Execute.
    await Utils.sleep(1000);
    await this.board.reconnect();
  }

  public async safebootRestart() {
    await this.board.safeboot(4000);
    await this.board.enterRawReplNoReset();
  }

  public async eval(c: string, timeout: number) {
    return await this.board.sendWait(c, null, timeout);
  }

  public async exit() {
    await this.stopWorking();
    await this.cleanClose();
  }

  public async stopWorking() {
    // This is the limit that this can be async-awaitified.
    // Does rely on callbacks to work.
    // eslint-disable-next-line no-unused-vars
    return new Promise((resolve, reject) => {
      if (this.working) {
        this.logger.info('Exiting shell while still working, doing interrupt');
        let cbDone = false;
        this.interruptCb = () => {
          cbDone = true;
          this.working = false;
          this.interrupted = false;
          this.interruptCb = null;
          this.logger.info('Interrupt done, closing');
          resolve(null);
        };
        this.interrupted = true;
        setTimeout(() => {
          if (!cbDone) {
            this.logger.info('Interrupt timed out, continuing anyway');
            resolve(null);
          }
        }, 1000);
      } else {
        this.logger.info('Not working, continuing closing');
        resolve(null);
      }
    });
  }

  public async cleanClose() {
    this.logger.info('Closing shell cleanly');

    if (this.settings.get(SettingsKey.rebootAfterUpload)) {
      this.logger.info('Rebooting after upload');
      // No need to await this.
      this.reset();
      return;
    }

    await this.board.enterFriendlyRepl();
    await this.board.send('\r\n');

    this.logger.info('Closed successfully');

    if (this.board.connection?.type !== 'serial') {
      await this.board.disconnectSilent();
    }
  }

  public async close() {
    this.logger.info('Closing shell cleanly');

    await this.board.enterFriendlyRepl();
    await this.board.send('\r\n');

    this.logger.info('Closed successfully');

    if (this.board.connection?.type !== 'serial') {
      await this.board.disconnectSilent();
    }
  }
}
