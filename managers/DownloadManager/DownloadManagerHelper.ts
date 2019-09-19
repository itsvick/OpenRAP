/**
 * @author Harish Kumar Gangula <harishg@ilimi.in>
 */
const { SuDScheduler } = require("su-downloader3");
import { Singleton, Inject } from "typescript-ioc";
import * as _ from "lodash";
import { logger } from "@project-sunbird/ext-framework-server/logger";
import { STATUS, STATUS_MESSAGE } from "./DownloadManager";
import { DataBaseSDK } from "../../sdks/DataBaseSDK";
import { EventManager } from "@project-sunbird/ext-framework-server/managers/EventManager";

@Singleton
export class DownloadManagerHelper {
  @Inject
  private dbSDK: DataBaseSDK;

  private dataBaseName = "download_queue";

  private suDScheduler;
  constructor() {
    // initialize the su downloader3 schedular
    const schedulerOptions = {
      autoStart: true,
      maxConcurrentDownloads: 1, //  don't change this which will give db duplicate update errors on progress
      downloadOptions: {
        threads: 1, // TODO: if threads are more than one the unzip is failing due to partials combined
        throttleRate: 2000,
        timeout: 60000
      }
    };
    this.suDScheduler = new SuDScheduler(schedulerOptions);
  }

  queueDownload = (
    downloadId: string,
    pluginId: string,
    locations: object,
    observer: any
  ): boolean => {
    return this.suDScheduler.queueDownload(downloadId, locations, observer);
  };

  pause = (downloadId: string): boolean => {
    return this.suDScheduler.pauseDownload(downloadId);
  };

  cancel = (downloadId: string): boolean => {
    return this.suDScheduler.killDownload(downloadId);
  };

  pauseAll = (stop: boolean = false): void => {
    this.suDScheduler.pauseAll(stop);
  };

  cancelAll = (): boolean => {
    let flag = false;
    if (!_.isEmpty(this.suDScheduler.taskQueue)) {
      _.forEach(this.suDScheduler.taskQueue, task => {
        flag = this.suDScheduler.killDownload(task.key);
      });
    }
    return false;
  };

  taskQueue = () => {
    return this.suDScheduler.taskQueue;
  };

  resumeDownload = () => {
    this.suDScheduler.startQueue();
  };
  downloadObserver = (downloadId: string, docId: string) => {
    return {
      next: progressInfo => {
        (async () => {
          try {
            const doc = await this.dbSDK.getDoc(this.dataBaseName, docId);
            // for initial call we will get the filesize
            if (progressInfo.filesize) {
              const files = _.map(doc.files, file => {
                if (file.id === downloadId) {
                  file.size = progressInfo.filesize;
                }
                return file;
              });
              doc.files = files;
              doc.status = STATUS.InProgress;
              doc.statusMsg = STATUS_MESSAGE.InProgress;
            }

            //sub-sequent calls we will get downloaded count
            if (_.get(progressInfo, "total.downloaded")) {
              let downloaded = progressInfo.total.downloaded;
              const files = _.map(doc.files, file => {
                if (file.id === downloadId) {
                  file.downloaded = downloaded;
                }
                return file;
              });
              doc.files = files;
              doc.stats.downloadedSize = _.sumBy(
                doc.files,
                file => file["downloaded"]
              );
            }
            doc.updatedOn = Date.now();
            delete doc["_rev"];
            await this.dbSDK.updateDoc(this.dataBaseName, docId, doc);
          } catch (error) {
            logger.error("While updating progress in database", error);
          }
        })();
      },
      error: error => {
        // generate the telemetry
        (async () => {
          try {
            // update the status to failed and remove other un processed files from queue
            await this.dbSDK.updateDoc(this.dataBaseName, docId, {
              status: STATUS.Failed,
              statusMsg: STATUS_MESSAGE.Failed,
              updatedOn: Date.now()
            });

            //remove pending items from downloadQueue

            const doc = await this.dbSDK.getDoc(this.dataBaseName, docId);
            let pluginId = doc.pluginId;
            delete doc.pluginId;
            delete doc.statusMsg;
            delete doc._rev;
            doc.id = doc._id;
            delete doc._id;
            EventManager.emit(`${pluginId}:download:failed`, doc);
          } catch (error) {
            logger.error(
              `DownloadManager: Error while downloading the data, ${error}`
            );
          }
        })();

        // Emit the event on error
      },
      complete: () => {
        (async () => {
          try {
            // log the info
            // generate the telemetry
            // update the status to completed

            const doc = await this.dbSDK.getDoc(this.dataBaseName, docId);
            let files = _.map(doc.files, file => {
              if (file.id === downloadId) {
                file.downloaded = file.size;
              }
              return file;
            });
            let stats = doc.stats;
            stats.downloadedFiles = doc.stats.downloadedFiles + 1;
            stats.downloadedSize = _.sumBy(files, file => file["downloaded"]);
            doc.files = files;
            doc.stats = stats;
            if (doc.stats.downloadedFiles === doc.files.length) {
              let pluginId = doc.pluginId;
              delete doc.pluginId;
              delete doc.statusMsg;
              delete doc._rev;
              doc.id = doc._id;
              delete doc._id;
              doc.status = STATUS.Completed;
              EventManager.emit(`${pluginId}:download:complete`, doc);
              return this.dbSDK.updateDoc(this.dataBaseName, docId, {
                files: files,
                stats: stats,
                status: STATUS.EventEmitted,
                updatedOn: Date.now()
              });
            } else {
              return this.dbSDK.updateDoc(this.dataBaseName, docId, {
                files: files,
                stats: stats,
                updatedOn: Date.now()
              });
            }
          } catch (error) {
            logger.error(
              `while processing download complete method ", ${error}, docId: ${docId}, fileId: ${downloadId}`
            );
          }
        })();
      }
    };
  };
}
