import * as electron from 'electron';
import { app, BrowserWindow, crashReporter, ipcMain } from 'electron';
import * as path from 'path';
import { format, parse } from 'url';

import { buildNumber, clientVersion, version } from '../../package.json';
import DesktopCapturerSource = Electron.DesktopCapturerSource;
import { apiName, WindowTypes } from '../common/api-interface';
import { isMac, isWindowsOS } from '../common/env';
import { i18n } from '../common/i18n';
import { getCommandLineArgs, getGuid } from '../common/utils';
import { AppMenu } from './app-menu';
import { handleChildWindow } from './child-window-handler';
import { config, IConfig } from './config-handler';
import { showNetworkConnectivityError } from './dialog-handler';
import { monitorWindowActions } from './window-actions';
import { createComponentWindow, getBounds, handleDownloadManager, injectStyles, windowExists } from './window-utils';

interface ICustomBrowserWindowConstructorOpts extends Electron.BrowserWindowConstructorOptions {
    winKey: string;
}

export interface ICustomBrowserWindow extends Electron.BrowserWindow {
    winName: string;
    notificationObj?: object;
}

// Default window width & height
const DEFAULT_WIDTH: number = 900;
const DEFAULT_HEIGHT: number = 900;

export class WindowHandler {

    /**
     * Loading window opts
     */
    private static getLoadingWindowOpts(): Electron.BrowserWindowConstructorOptions {
        return {
            alwaysOnTop: false,
            center: true,
            frame: false,
            height: 200,
            maximizable: false,
            minimizable: false,
            resizable: false,
            show: false,
            title: 'Symphony',
            width: 400,
            webPreferences: {
                sandbox: true,
                nodeIntegration: false,
                devTools: false,
            },
        };
    }

    /**
     * Screen picker window opts
     */
    private static getScreenPickerWindowOpts(): ICustomBrowserWindowConstructorOpts {
        return {
            alwaysOnTop: true,
            autoHideMenuBar: true,
            frame: false,
            height: isMac ? 519 : 523,
            width: 580,
            modal: false,
            resizable: true,
            show: false,
            webPreferences: {
                nodeIntegration: false,
                sandbox: true,
            },
            winKey: getGuid(),
        };
    }

    /**
     * Screen sharing indicator window opts
     */
    private static getScreenSharingIndicatorOpts(): ICustomBrowserWindowConstructorOpts {
        return {
            width: 592,
            height: 48,
            show: false,
            modal: true,
            frame: false,
            focusable: false,
            transparent: true,
            autoHideMenuBar: true,
            resizable: false,
            alwaysOnTop: true,
            webPreferences: {
                sandbox: true,
                nodeIntegration: false,
                devTools: false,
            },
            winKey: getGuid(),
        };
    }

    /**
     * Basic auth window opts
     */
    private static getBasicAuthOpts(): ICustomBrowserWindowConstructorOpts {
        return {
            width: 360,
            height: isMac ? 270 : 295,
            show: false,
            modal: true,
            autoHideMenuBar: true,
            resizable: false,
            webPreferences: {
                sandbox: true,
                nodeIntegration: false,
                devTools: false,
            },
            winKey: getGuid(),
        };
    }

    /**
     * Verifies if the url is valid and
     * forcefully appends https if not present
     *
     * @param configURL {string}
     */
    private static getValidUrl(configURL: string): string {
        const parsedUrl = parse(configURL);

        if (!parsedUrl.protocol || parsedUrl.protocol !== 'https') {
            parsedUrl.protocol = 'https:';
            parsedUrl.slashes = true;
        }
        return format(parsedUrl);
    }

    public appMenu: AppMenu | null;
    public isAutoReload: boolean;
    public isOnline: boolean;
    public url: string | undefined;
    public willQuitApp: boolean = false;

    private readonly windowOpts: ICustomBrowserWindowConstructorOpts;
    private readonly globalConfig: IConfig;
    private readonly config: IConfig;
    // Window reference
    private readonly windows: object;
    private readonly isCustomTitleBarAndWindowOS: boolean;

    private mainWindow: ICustomBrowserWindow | null = null;
    private loadingWindow: Electron.BrowserWindow | null = null;
    private aboutAppWindow: Electron.BrowserWindow | null = null;
    private moreInfoWindow: Electron.BrowserWindow | null = null;
    private screenPickerWindow: Electron.BrowserWindow | null = null;
    private screenSharingIndicatorWindow: Electron.BrowserWindow | null = null;
    private basicAuthWindow: Electron.BrowserWindow | null = null;

    constructor(opts?: Electron.BrowserViewConstructorOptions) {
        // Settings
        this.config = config.getConfigFields([ 'isCustomTitleBar', 'mainWinPos', 'minimizeOnClose' ]);
        this.globalConfig = config.getGlobalConfigFields([ 'url', 'crashReporter' ]);

        this.windows = {};
        this.windowOpts = { ...this.getMainWindowOpts(), ...opts };
        this.isAutoReload = false;
        this.isOnline = true;
        this.isCustomTitleBarAndWindowOS = isWindowsOS && this.config.isCustomTitleBar;

        this.appMenu = null;

        try {
            const extra = { podUrl: this.globalConfig.url, process: 'main' };
            crashReporter.start({ ...this.globalConfig.crashReporter, extra });
        } catch (e) {
            throw new Error('failed to init crash report');
        }
    }

    /**
     * Starting point of the app
     */
    public createApplication() {
        // set window opts with additional config
        this.mainWindow = new BrowserWindow({
            ...this.windowOpts, ...getBounds(this.config.mainWinPos, DEFAULT_WIDTH, DEFAULT_HEIGHT),
        }) as ICustomBrowserWindow;
        this.mainWindow.winName = apiName.mainWindowName;

        // Event needed to hide native menu bar on Windows 10 as we use custom menu bar
        this.mainWindow.webContents.once('did-start-loading', () => {
            if ((this.config.isCustomTitleBar || isWindowsOS) && this.mainWindow && windowExists(this.mainWindow)) {
                this.mainWindow.setMenuBarVisibility(false);
            }
        });

        // Get url to load from cmd line or from global config file
        const urlFromCmd = getCommandLineArgs(process.argv, '--url=', false);
        this.url = urlFromCmd && urlFromCmd.substr(6) || WindowHandler.getValidUrl(this.globalConfig.url);

        // loads the main window with url from config/cmd line
        this.mainWindow.loadURL(this.url);
        this.mainWindow.webContents.on('did-finish-load', async () => {

            // Displays a dialog if network connectivity has been lost
            const retry = () => {
                if (!this.mainWindow) {
                    return;
                }
                if (!this.isOnline) {
                    showNetworkConnectivityError(this.mainWindow, this.url, retry);
                }
                this.mainWindow.webContents.reload();
            };
            if (!this.isOnline && this.mainWindow) {
                showNetworkConnectivityError(this.mainWindow, this.url, retry);
            }

            // early exit if the window has already been destroyed
            if (!this.mainWindow || !windowExists(this.mainWindow)) {
                return;
            }
            this.url = this.mainWindow.webContents.getURL();

            // Injects custom title bar css into the webContents
            // only for Window and if it is enabled
            await injectStyles(this.mainWindow, this.isCustomTitleBarAndWindowOS);
            if (this.isCustomTitleBarAndWindowOS) {
                this.mainWindow.webContents.send('initiate-custom-title-bar');
            }

            this.mainWindow.webContents.send('page-load', {
                isWindowsOS,
                locale: i18n.getLocale(),
                resources: i18n.loadedResources,
                origin: this.globalConfig.url,
            });
            this.appMenu = new AppMenu();

            // close the loading window when
            // the main windows finished loading
            if (this.loadingWindow) {
                this.loadingWindow.destroy();
                this.loadingWindow = null;
            }

            // Ready to show the window
            this.mainWindow.show();
        });

        // Handle main window close
        this.mainWindow.on('close', (event) => {
            if (!this.mainWindow || !windowExists(this.mainWindow)) {
                return;
            }

            if (this.willQuitApp) {
                return this.destroyAllWindow();
            }

            if (this.config.minimizeOnClose) {
                event.preventDefault();
                isMac ? this.mainWindow.hide() : this.mainWindow.minimize();
            } else {
                app.quit();
            }
        });

        // Start monitoring window actions
        monitorWindowActions(this.mainWindow);

        // Download manager
        this.mainWindow.webContents.session.on('will-download', handleDownloadManager);

        // store window ref
        this.addWindow(this.windowOpts.winKey, this.mainWindow);

        // Handle pop-outs window
        handleChildWindow(this.mainWindow.webContents);
        return this.mainWindow;
    }

    /**
     * Gets the main window
     */
    public getMainWindow(): ICustomBrowserWindow | null {
        return this.mainWindow;
    }

    /**
     * Gets all the window that we have created
     *
     * @return {Electron.BrowserWindow}
     *
     */
    public getAllWindows(): object {
        return this.windows;
    }

    /**
     * Closes the window from an event emitted by the render processes
     *
     * @param windowType {WindowTypes}
     * @param winKey {string} - Unique ID assigned to the window
     */
    public closeWindow(windowType: WindowTypes, winKey?: string): void {
        switch (windowType) {
            case 'screen-picker':
                if (this.screenPickerWindow && windowExists(this.screenPickerWindow)) {
                    this.screenPickerWindow.close();
                }
                break;
            case 'screen-sharing-indicator':
                if (winKey) {
                    const browserWindow = this.windows[ winKey ];
                    if (browserWindow && windowExists(browserWindow)) {
                        browserWindow.close();
                    }
                }
                break;
            default:
                break;
        }
    }

    /**
     * Sets is auto reload when the application
     * is auto reloaded for optimizing memory
     *
     * @param shouldAutoReload {boolean}
     */
    public setIsAutoReload(shouldAutoReload: boolean): void {
        this.isAutoReload = shouldAutoReload;
    }

    /**
     * Checks if the window and a key has a window
     *
     * @param key {string}
     * @param window {Electron.BrowserWindow}
     */
    public hasWindow(key: string, window: Electron.BrowserWindow): boolean {
        const browserWindow = this.windows[ key ];
        return browserWindow && window === browserWindow;
    }

    /**
     * Displays a loading window until the main
     * application is loaded
     */
    public showLoadingScreen(): void {
        this.loadingWindow = createComponentWindow('loading-screen', WindowHandler.getLoadingWindowOpts());
        this.loadingWindow.webContents.once('did-finish-load', () => {
            if (!this.loadingWindow || !windowExists(this.loadingWindow)) {
                return;
            }
            this.loadingWindow.webContents.send('data');
        });

        this.loadingWindow.once('closed', () => this.loadingWindow = null);
    }

    /**
     * Creates a about app window
     */
    public createAboutAppWindow(): void {
        this.aboutAppWindow = createComponentWindow('about-app');
        this.aboutAppWindow.webContents.once('did-finish-load', () => {
            if (!this.aboutAppWindow || !windowExists(this.aboutAppWindow)) {
                return;
            }
            this.aboutAppWindow.webContents.send('about-app-data', { buildNumber, clientVersion, version });
        });
    }

    /**
     * Creates a more info window
     */
    public createMoreInfoWindow(): void {
        this.moreInfoWindow = createComponentWindow('more-info');
        this.moreInfoWindow.webContents.once('did-finish-load', () => {
            if (!this.moreInfoWindow || !windowExists(this.moreInfoWindow)) {
                return;
            }
            this.moreInfoWindow.webContents.send('more-info-data');
        });
    }

    /**
     * Creates a screen picker window
     *
     * @param window
     * @param sources
     * @param id
     */
    public createScreenPickerWindow(window: Electron.WebContents, sources: DesktopCapturerSource[], id: number): void {

        if (this.screenPickerWindow && windowExists(this.screenPickerWindow)) {
            this.screenPickerWindow.close();
        }

        const opts = WindowHandler.getScreenPickerWindowOpts();
        this.screenPickerWindow = createComponentWindow('screen-picker', opts);
        this.screenPickerWindow.webContents.once('did-finish-load', () => {
            if (!this.screenPickerWindow || !windowExists(this.screenPickerWindow)) {
                return;
            }
            this.screenPickerWindow.webContents.send('screen-picker-data', { sources, id });
            this.addWindow(opts.winKey, this.screenPickerWindow);
        });
        ipcMain.once('screen-source-selected', (_event, source) => {
            window.send('start-share' + id, source);
            if (this.screenPickerWindow && windowExists(this.screenPickerWindow)) {
                this.screenPickerWindow.close();
            }
        });
        this.screenPickerWindow.once('closed', () => {
            this.removeWindow(opts.winKey);
            this.screenPickerWindow = null;
        });
    }

    /**
     * Creates a Basic auth window whenever the network
     * requires authentications
     *
     * Invoked by app.on('login')
     *
     * @param window
     * @param hostname
     * @param isMultipleTries
     * @param clearSettings
     * @param callback
     */
    public createBasicAuthWindow(window: ICustomBrowserWindow, hostname: string, isMultipleTries: boolean, clearSettings, callback): void {
        const opts = WindowHandler.getBasicAuthOpts();
        opts.parent = window;
        this.basicAuthWindow = createComponentWindow('basic-auth', opts);
        this.basicAuthWindow.setVisibleOnAllWorkspaces(true);
        this.basicAuthWindow.webContents.once('did-finish-load', () => {
            if (!this.basicAuthWindow || !windowExists(this.basicAuthWindow)) {
                return;
            }
            this.basicAuthWindow.webContents.send('basic-auth-data', { hostname, isValidCredentials: isMultipleTries });
        });
        const closeBasicAuth = (shouldClearSettings = true) => {
            if (shouldClearSettings) {
                clearSettings();
            }
            if (this.basicAuthWindow && !windowExists(this.basicAuthWindow)) {
                this.basicAuthWindow.close();
                this.basicAuthWindow = null;
            }
        };

        const login = (_event, arg) => {
            const { username, password } = arg;
            callback(username, password);
            closeBasicAuth(false);
        };

        this.basicAuthWindow.on('close', () => {
            ipcMain.removeListener('basic-auth-closed', closeBasicAuth);
            ipcMain.removeListener('basic-auth-login', login);
        });

        ipcMain.once('basic-auth-closed', closeBasicAuth);
        ipcMain.once('basic-auth-login', login);
    }

    /**
     * Creates a screen sharing indicator whenever uses start
     * sharing the screen
     *
     * @param screenSharingWebContents {Electron.webContents}
     * @param displayId {string} - current display id
     * @param id {number} - postMessage request id
     * @param streamId {string} - MediaStream id
     */
    public createScreenSharingIndicatorWindow(
        screenSharingWebContents: Electron.webContents,
        displayId: string,
        id: number,
        streamId,
    ): void {
        const indicatorScreen =
            (displayId && electron.screen.getAllDisplays().filter((d) =>
                displayId.includes(d.id.toString()))[ 0 ]) || electron.screen.getPrimaryDisplay();

        const screenRect = indicatorScreen.workArea;
        // Set stream id as winKey to link stream to the window
        let opts = { ...WindowHandler.getScreenSharingIndicatorOpts(), ...{ winKey: streamId } };
        if (opts.width && opts.height) {
            opts = Object.assign({}, opts, {
                x: screenRect.x + Math.round((screenRect.width - opts.width) / 2),
                y: screenRect.y + screenRect.height - opts.height,
            });
        }
        this.screenSharingIndicatorWindow = createComponentWindow('screen-sharing-indicator', opts);
        this.screenSharingIndicatorWindow.setVisibleOnAllWorkspaces(true);
        this.screenSharingIndicatorWindow.webContents.once('did-finish-load', () => {
            if (!this.screenSharingIndicatorWindow || !windowExists(this.screenSharingIndicatorWindow)) {
                return;
            }
            this.screenSharingIndicatorWindow.webContents.send('screen-sharing-indicator-data', { id, streamId });
        });
        const stopScreenSharing = (_event, indicatorId) => {
            if (id === indicatorId) {
                screenSharingWebContents.send('screen-sharing-stopped', id);
            }
        };

        this.addWindow(opts.winKey, this.screenSharingIndicatorWindow);

        this.screenSharingIndicatorWindow.once('close', () => {
            this.removeWindow(streamId);
            ipcMain.removeListener('stop-screen-sharing', stopScreenSharing);
        });

        ipcMain.once('stop-screen-sharing', stopScreenSharing);
    }

    /**
     * Opens an external url in the system's default browser
     *
     * @param urlToOpen
     */
    public openUrlInDefaultBrowser(urlToOpen) {
        if (urlToOpen) {
            electron.shell.openExternal(urlToOpen);
        }
    }

    /**
     * Stores information of all the window we have created
     *
     * @param key {string}
     * @param browserWindow {Electron.BrowserWindow}
     */
    public addWindow(key: string, browserWindow: Electron.BrowserWindow): void {
        this.windows[ key ] = browserWindow;
    }

    /**
     * Removes the window reference
     *
     * @param key {string}
     */
    public removeWindow(key: string): void {
        delete this.windows[ key ];
    }

    /**
     * Cleans up reference
     */
    private destroyAllWindow(): void {
        for (const key in this.windows) {
            if (Object.prototype.hasOwnProperty.call(this.windows, key)) {
                const winKey = this.windows[ key ];
                this.removeWindow(winKey);
            }
        }
        this.mainWindow = null;
    }

    /**
     * Main window opts
     */
    private getMainWindowOpts(): ICustomBrowserWindowConstructorOpts {
        return {
            alwaysOnTop: false,
            frame: !this.isCustomTitleBarAndWindowOS,
            minHeight: 300,
            minWidth: 300,
            show: false,
            title: 'Symphony',
            webPreferences: {
                nodeIntegration: false,
                preload: path.join(__dirname, '../renderer/_preload-main.js'),
                sandbox: true,
                contextIsolation: true,
            },
            winKey: getGuid(),
        };
    }
}

const windowHandler = new WindowHandler();

export { windowHandler };