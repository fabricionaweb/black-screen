import {SessionComponent} from "./2_SessionComponent";
import {TabComponent, TabProps, Tab} from "./TabComponent";
import * as React from "react";
import * as _ from "lodash";
import {ipcRenderer} from "electron";
import {remote} from "electron";
import * as css from "./css/main";
import {saveWindowBounds} from "./ViewUtils";
import {StatusBarComponent} from "./StatusBarComponent";
import {PaneTree, Pane} from "../utils/PaneTree";
import {SearchComponent} from "./SearchComponent";

export class ApplicationComponent extends React.Component<{}, {}> {
    private tabs: Tab[] = [];
    private focusedTabIndex: number;

    constructor(props: {}) {
        super(props);
        const electronWindow = remote.BrowserWindow.getAllWindows()[0];

        this.addTab(false);

        electronWindow
            .on("move", () => saveWindowBounds(electronWindow))
            .on("resize", () => {
                saveWindowBounds(electronWindow);
                this.recalculateDimensions();
            })
            .webContents
            .on("devtools-opened", () => this.recalculateDimensions())
            .on("devtools-closed", () => this.recalculateDimensions());

        ipcRenderer.on("change-working-directory", (event: Electron.IpcRendererEvent, directory: string) =>
            this.focusedTab.focusedPane.session.directory = directory
        );

        window.onbeforeunload = () => {
            electronWindow
                .removeAllListeners()
                .webContents
                .removeAllListeners("devtools-opened")
                .removeAllListeners("devtools-closed")
                .removeAllListeners("found-in-page");

            this.closeAllTabs();
        };

        window.application = this;
    }

    addTab(forceUpdate = true): void {
        if (this.tabs.length < 9) {
            this.tabs.push(new Tab(this));
            this.focusedTabIndex = this.tabs.length - 1;
            if (forceUpdate) this.forceUpdate();
        } else {
            remote.shell.beep();
        }

        window.focusedTab = this.focusedTab;
    }

    focusTab(position: OneBasedPosition): void {
        const index = position === 9 ? this.tabs.length : position - 1;

        if (this.tabs.length > index) {
            this.focusedTabIndex = index;
            this.forceUpdate();
        } else {
            remote.shell.beep();
        }

        window.focusedTab = this.focusedTab;
    }

    closeFocusedTab() {
        this.closeTab(this.focusedTab);

        this.forceUpdate();
    }

    activatePreviousTab() {
        let newPosition = this.focusedTabIndex - 1;

        if (newPosition < 0) {
            newPosition = this.tabs.length - 1;
        }

        this.focusTab(newPosition + 1);
    }

    activateNextTab() {
        let newPosition = this.focusedTabIndex + 1;

        if (newPosition >= this.tabs.length) {
            newPosition = 0;
        }

        this.focusTab(newPosition + 1);
    }

    // FIXME: this method should be private.
    closeFocusedPane() {
        this.focusedTab.closeFocusedPane();

        if (this.focusedTab.panes.size === 0) {
            this.closeTab(this.focusedTab);
        }

        this.forceUpdate();
    }

    render() {
        let tabs: React.ReactElement<TabProps>[] | undefined;

        if (this.tabs.length > 1) {
            tabs = this.tabs.map((tab: Tab, index: number) =>
                <TabComponent isFocused={index === this.focusedTabIndex}
                              key={index}
                              position={index + 1}
                              activate={() => {
                                this.focusedTabIndex = index;
                                this.forceUpdate();
                              }}
                              closeHandler={(event: React.MouseEvent<HTMLSpanElement>) => {
                                  this.closeTab(this.tabs[index]);
                                  this.forceUpdate();

                                  event.stopPropagation();
                                  event.preventDefault();
                              }}>
                </TabComponent>
            );
        }

        return (
            <div style={css.application}>
                <div style={css.titleBar}>
                    <ul style={css.tabs}>{tabs}</ul>
                    <SearchComponent/>
                </div>
                {this.renderPanes(this.focusedTab.panes)}
                <StatusBarComponent presentWorkingDirectory={this.focusedTab.focusedPane.session.directory}/>
            </div>
        );
    }

    private renderPanes(tree: PaneTree): JSX.Element {
        if (tree instanceof Pane) {
            const pane = tree;
            const session = pane.session;
            const isFocused = pane === this.focusedTab.focusedPane;

            return (
                <SessionComponent session={session}
                                  key={session.id}
                                  isFocused={isFocused}
                                  updateStatusBar={isFocused ? () => this.forceUpdate() : undefined}
                                  focus={() => {
                                      this.focusedTab.activatePane(pane);
                                      this.forceUpdate();
                                  }}>
                </SessionComponent>
            );
        } else {
            return <div style={css.sessions(tree)}>{tree.children.map(child => this.renderPanes(child))}</div>;
        }
    }

    private recalculateDimensions() {
        for (const tab of this.tabs) {
            tab.updateAllPanesDimensions();
        }
    }

    private get focusedTab(): Tab {
        return this.tabs[this.focusedTabIndex];
    }

    private closeTab(tab: Tab, quit = true): void {
        tab.closeAllPanes();
        _.pull(this.tabs, tab);

        if (this.tabs.length === 0 && quit) {
            ipcRenderer.send("quit");
        } else if (this.tabs.length === this.focusedTabIndex) {
            this.focusedTabIndex -= 1;
        }

        window.focusedTab = this.focusedTab;
    }

    private closeAllTabs(): void {
        // Can't use forEach here because closeTab changes the array being iterated.
        while (this.tabs.length) {
            this.closeTab(this.tabs[0], false);
        }
    }
}
