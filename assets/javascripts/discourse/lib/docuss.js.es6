import { withPluginApi } from "discourse/lib/plugin-api";
import { getOwner } from "discourse-common/lib/get-owner";
import { schedule } from "@ember/runloop";

const cleanupHandlers = new Set();
const addCleanup = (fn) => cleanupHandlers.add(fn);

export default {
    name: "docuss",
    initialize(container) {
        const siteSettings = container.lookup("service:site-settings");
        if (!siteSettings?.docuss_enabled) {
            return;
        }

        withPluginApi("1.2.0", (api) => {
            try {
                // Logo management with error handling
                container.dcsHeaderLogo = {
                    _observers: new Set(),
                    setLogo(logos) {
                        try {
                            // Logo update logic
                            this._observers.forEach(callback => callback(logos));
                        } catch (err) {
                            console.error("Error updating logo:", err);
                        }
                    },
                    addObserver(callback) {
                        this._observers.add(callback);
                        return () => this._observers.delete(callback);
                    }
                };

                // Route change handling with safety
                const handlePageChange = (data) => {
                    try {
                        const currentRouteName = data?.currentRouteName || data?.routeName;
                        const url = data?.url || window.location.href;

                        // Page change logic here
                        if (currentRouteName?.startsWith("topic.")) {
                            // Topic-specific handling
                            const composerController = getOwner(this).lookup("controller:composer");
                            if (composerController) {
                                const model = composerController.get("model");
                                if (model?.get) {
                                    // Model operations
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Error in page change handler:", err);
                    }
                };

                // Mobile view handling with proper setProperties
                api.onAppEvent("site:currentProp", ({ key, value }) => {
                    if (key === "mobileView") {
                        const site = api.container.lookup("site:main");
                        if (site && typeof site.setProperties === "function") {
                            site.setProperties({ mobileView: value });
                        }
                    }
                });

                // Register cleanup handlers
                api.cleanupStream(cleanupHandlers);

            } catch (err) {
                console.error("Error initializing Docuss plugin:", err);
            }
        });
    }
};