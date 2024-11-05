/* eslint-disable consistent-return */
import type {
  SpyMessage,
  OnInitParams,
  PageSpyPlugin,
  PluginOrder,
  InitConfigBase,
} from '@huolala-tech/page-spy-types';
import {
  psLog,
  removeEndSlash,
  RequestItem,
  SocketStoreBase,
} from '@huolala-tech/page-spy-base';
import { BlobHarbor, PERIOD_DIVIDE_IDENTIFIER } from './harbor/blob';
import { DownloadArgs, startDownload } from './utils/download';
import { UploadArgs, startUpload } from './utils/upload';
import { getDeviceId, isValidPeriod, jsonToFile, makeData } from './utils';
import { Actions, CacheMessageItem, DataType } from './harbor/base';

interface DataHarborConfig {
  // Specify the maximum bytes of single harbor's container.
  // Default 10 * 1024 * 1024, 10MB.
  // If a period is specified, it will use the period.
  maximum?: number;

  // Set the duration of each period in milliseconds.
  // Default is `null`, indicating no period division.
  period?: number | null;

  // Specify which types of data to collect.
  caredData?: Record<DataType, boolean>;

  // Custom uploaded filename by this.
  // Default value is `new Date().toLocaleString()`.
  filename?: () => string;

  // Custom download behavior.
  onDownload?: (data: CacheMessageItem[]) => void;
}

const defaultConfig: DataHarborConfig = {
  maximum: 10 * 1024 * 1024,
  period: null,
  caredData: {
    console: true,
    network: true,
    storage: true,
    system: true,
    'rrweb-event': true,
  },
  filename: () => {
    return new Date().toLocaleString();
  },
};

export default class DataHarborPlugin implements PageSpyPlugin {
  public enforce: PluginOrder = 'pre';

  public name = 'DataHarborPlugin';

  // "Harbor" is an abstraction for scheduling data actions.
  public harbor: BlobHarbor;

  public apiBase: string = '';

  public isPaused = false;

  private periodTimer: ReturnType<typeof setInterval> | null = null;

  public $socketStore: SocketStoreBase | null = null;

  public $pageSpyConfig: InitConfigBase | null = null;

  public $harborConfig: Required<DataHarborConfig>;

  public static hasInited = false;

  public static hasMounted = false;

  constructor(config?: DataHarborConfig) {
    this.$harborConfig = {
      ...defaultConfig,
      ...config,
    } as Required<DataHarborConfig>;

    this.harbor = new BlobHarbor({
      maximum: this.$harborConfig.maximum,
      period: this.$harborConfig.period,
    });
  }

  public async onInit({ socketStore, config }: OnInitParams<InitConfigBase>) {
    if (DataHarborPlugin.hasInited) return;
    DataHarborPlugin.hasInited = true;

    this.$pageSpyConfig = config;
    this.$socketStore = socketStore;

    const { api, enableSSL, offline } = config;
    if (!offline && !api) {
      psLog.warn(
        "Cannot upload log to PageSpy for miss 'api' configuration. See: ",
        config,
      );
    } else {
      const apiScheme = enableSSL ? 'https://' : 'http://';
      this.apiBase = removeEndSlash(`${apiScheme}${api}`);
    }

    this.initPeriodTimer();

    this.$socketStore.addListener('public-data', (message) => {
      if (this.isPaused || !this.isCaredPublicData(message)) return;

      const data = makeData(message.type, message.data);

      const ok = this.harbor.add(data);
      if (!ok) {
        psLog.warn(`[${this.name}] Fail to save data in harbor `, data);
      }
    });
  }

  private initPeriodTimer() {
    if (isValidPeriod(this.$harborConfig.period)) {
      if (this.periodTimer) {
        clearInterval(this.periodTimer);
      }
      this.periodTimer = setInterval(() => {
        this.harbor.add(PERIOD_DIVIDE_IDENTIFIER);
        // Notify other plugins to resend a full snapshot.
        this.$socketStore?.dispatchEvent('harbor-clear', null);
      }, this.$harborConfig.period);
    }
  }

  // public onMounted({ config }: OnMountedParams) {
  //   if (DataHarborPlugin.hasMounted) return;
  //   DataHarborPlugin.hasMounted = true;

  //   if (isBrowser()) {
  //     const downloadBtn = buttonBindWithDownload(async () => {
  //       await this.onOfflineLog('download', false);
  //     });
  //     const uploadBtn = buttonBindWithUpload(async () => {
  //       const debugUrl = await this.onOfflineLog('upload', false);
  //       psLog.info(`${UPLOAD_TIPS.success}: ${debugUrl}`);
  //       return debugUrl;
  //     });

  //     content.insertAdjacentElement('beforeend', downloadBtn);
  //     content.insertAdjacentElement('beforeend', uploadBtn);
  //   }
  // }

  getParams(type: 'download'): Promise<DownloadArgs>;
  getParams(type: 'upload'): Promise<UploadArgs>;
  async getParams(type: Actions) {
    const { onDownload, filename } = this.$harborConfig;
    const { project = '', title = '' } = this.$pageSpyConfig || {};
    const tags = {
      project,
      title,
      deviceId: getDeviceId(),
      userAgent: navigator.userAgent,
    };
    const data = await this.harbor.getAll();
    // TODO
    // 需要区分 data ，如果分段了需要有更多操作
    if (type === 'download') {
      return {
        data,
        filename,
        customDownload: onDownload,
      } as DownloadArgs;
    }

    if (type === 'upload') {
      const file = jsonToFile(data, filename());
      const form = new FormData();
      form.append('log', file);
      return {
        url: `${this.apiBase}/api/v1/log/upload?${new URLSearchParams(tags).toString()}`,
        body: form,
      } as UploadArgs;
    }
  }

  onOfflineLog(type: 'download', clearCache?: boolean): Promise<void>;
  onOfflineLog(type: 'upload', clearCache?: boolean): Promise<string>;
  async onOfflineLog(type: Actions, clearCache = true): Promise<void | string> {
    try {
      let result;
      if (type === 'download') {
        const downloadArgs = await this.getParams('download');
        await startDownload(downloadArgs);
      }
      if (type === 'upload') {
        const uploadArgs = await this.getParams('upload');
        result = await startUpload(uploadArgs);
      }

      if (clearCache) {
        this.harbor.clear();
        this.$socketStore?.dispatchEvent('harbor-clear', null);
      }

      if (result) {
        return this.getDebugUrl(result);
      }
    } catch (e: any) {
      psLog.error(e.message);
    }
  }

  onReset() {
    if (this.periodTimer) {
      clearInterval(this.periodTimer);
      this.periodTimer = null;
    }
    this.harbor.clear();
    DataHarborPlugin.hasInited = false;
    DataHarborPlugin.hasMounted = false;
    const node = document.getElementById('data-harbor-plugin-download');
    if (node) {
      node.remove();
    }
  }

  public pause() {
    this.isPaused = true;
  }

  public resume() {
    this.isPaused = false;
  }

  // Drop data in harbor and re-record
  public reharbor() {
    this.initPeriodTimer();
    this.harbor.clear();
    this.$socketStore?.dispatchEvent('harbor-clear', null);
    if (this.isPaused) {
      this.isPaused = false;
    }
  }

  public isCaredPublicData(message: SpyMessage.MessageItem) {
    if (!message) return false;
    const { type } = message;
    const { caredData } = this.$harborConfig;
    switch (type) {
      case 'console':
      case 'storage':
      case 'system':
      case 'rrweb-event':
        return caredData[type];
      case 'network':
        const { url } = message.data as RequestItem;
        const isFetchHarborStockUrl = this.harbor.stock.includes(url);

        if (caredData.network && !isFetchHarborStockUrl) return true;
        return false;
      // case DEBUG_MESSAGE_TYPE.DATABASE:
      //   if (['update', 'clear', 'drop'].includes(data.action)) {
      //     if (data.database?.includes(SKIP_PUBLIC_IDB_PREFIX)) {
      //       return false;
      //     }
      //     return true;
      //   }
      //   break;
      default:
        return false;
    }
  }

  getDebugUrl(result: H.UploadResult | null) {
    if (!result || !result.success) return '';

    const debugOrigin = `${removeEndSlash(this.$pageSpyConfig?.clientOrigin!)}/#/replay`;
    const logUrl = `${this.apiBase}/api/v1/log/download?fileId=${result.data.fileId}`;
    return `${debugOrigin}?url=${logUrl}`;
  }
}
