import { schedule } from "@ember/runloop";
import { withPluginApi } from "discourse/lib/plugin-api";
import { setDefaultHomepage } from "discourse/lib/utilities";
import Composer from "discourse/models/composer";

import { DcsIFrame } from "../lib/DcsIFrame";
import { DcsTag } from "../lib/DcsTag";
import { discourseAPI } from "../lib/discourseAPI";
import { onAfterRender } from "../lib/onAfterRender";
import { onDidTransition } from "../lib/onDidTransition";

export default {
  name: "docuss",
  initialize(container, app) {
    // If plugin is disabled, quit
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings?.docuss_enabled) {
      return;
    }

    let dcsIFrame;
    let cleanup = () => {};

    // Initialize plugin
    const initializePlugin = () => {
      setDefaultHomepage("docuss");
      
      // Create the IFrame instance
      dcsIFrame = new DcsIFrame(app, container);
      
      // Wait until page is rendered, then modify stuff
      afterRender().then(() => onAfterRender(container));

      // Add the 'r' query param
      container.lookup("controller:application").reopen({
        queryParams: { showRight: "r" },
        showRight: true,
      });

      // Modern logo management with cleanup and error handling
      container.dcsHeaderLogo = {
        _logoUrl: null,
        _mobileLogoUrl: null,
        _smallLogoUrl: null,
        _href: null,
        _observers: new Set(),
        setLogo(logos) {
          // Store new values
          this._logoUrl = logos?.logoUrl;
          this._mobileLogoUrl = logos?.mobileLogoUrl;
          this._smallLogoUrl = logos?.smallLogoUrl;
          this._href = logos?.href;

          const updateLogoInDom = () => {
            try {
              const header = document.querySelector(".d-header");
              if (!header) return;

              // Update logo link
              const logoLink = header.querySelector("#site-logo");
              if (logoLink && this._href) {
                logoLink.href = this._href;
              }

              // Update logo image
              const logoImg = header.querySelector(".logo-big") || 
                            header.querySelector(".logo-small");
              if (logoImg && this._logoUrl) {
                // Create new image to handle load errors
                const newImg = new Image();
                newImg.onload = () => {
                  logoImg.src = this._logoUrl;
                };
                newImg.onerror = (err) => {
                  console.error("Failed to load logo:", err);
                };
                newImg.src = this._logoUrl;
              }

              // Force rerender using modern approach
              const headerTitle = header.querySelector(".title");
              if (headerTitle) {
                headerTitle.style.visibility = "hidden";
                requestAnimationFrame(() => {
                  headerTitle.style.removeProperty("visibility");
                });
              }

              // Notify observers
              this._observers.forEach(cb => cb(this));
            } catch (err) {
              console.error("Error updating logo:", err);
            }
          };

          // Schedule update
          schedule("afterRender", updateLogoInDom);
        },
        
        // Add observer support
        addObserver(callback) {
          this._observers.add(callback);
          return () => this._observers.delete(callback);
        }
      };

      // Add to cleanup
      cleanup = () => {
        container.dcsHeaderLogo._observers.clear();
      };

      let lastUrl = "";
      let shrinkComposer = true;
      let pageChangeHandlers = new Set();

      withPluginApi("1.2.0", (api) => {
        // Modern route change handler with error boundary
        const handlePageChange = (data) => {
          try {
            const currentRouteName = data?.currentRouteName || data?.routeName;
            const url = data?.url || window.location.href;

            if (!url || url === lastUrl) return;

            const queryParamsOnly = url.split("?")[0] === lastUrl.split("?")[0];
            lastUrl = url;

            onDidTransition({
              container,
              iframe: dcsIFrame,
              routeName: currentRouteName,
              queryParamsOnly,
            });

            if (shrinkComposer) {
              const composer = container.lookup("controller:composer");
              composer?.shrink?.();
            }
            shrinkComposer = true;
          } catch (err) {
              console.error("Error in page change handler:", err);
            }
          };

          // Listen to both old and new event names for broader compatibility
          api.onAppEvent("page:changed", handlePageChange);
          api.onPageChange(handlePageChange);

          // Also hook into router transitions directly as a fallback
          api.onPageChange((data) => {
            handlePageChange(data);
          });
      });

      // Modify iframe creation to use proxy if needed
      const iframeContainer = document.querySelector(".dcs-iframe-container");
      if (iframeContainer) {
        const iframe = iframeContainer.querySelector("iframe");
        if (iframe) {
          const originalUrl = iframe.src;
          const proxyUrl = `/proxy?url=${encodeURIComponent(originalUrl)}`;
          
          // Create a new iframe with sandbox attributes
          const newIframe = document.createElement('iframe');
          newIframe.src = proxyUrl;
          newIframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups allow-forms allow-presentation');
          newIframe.setAttribute('allow', 'fullscreen');
          newIframe.style.width = '100%';
          newIframe.style.height = '100%';
          newIframe.style.border = 'none';
          
          // Add event listener for load errors
          newIframe.onerror = () => {
            console.error('Failed to load iframe content');
          };
          
          // Replace the old iframe
          iframe.parentNode.replaceChild(newIframe, iframe);
        }
      }

      // Use modern plugin API to handle composer changes
      withPluginApi("1.2.0", (api) => {
        // Hook into composer opening
        api.onAppEvent("composer:opened", () => {
          schedule("afterRender", () => {
            const composerController = container.lookup("controller:composer");
            if (!composerController) return;

            const model = composerController.get("model");
            if (!model) return;

            const state = model.get("composeState");
            if (state !== Composer.OPEN) return;

            const tags = model.tags || (model.topic && model.topic.tags);
            const dcsTag = tags && tags.find((t) => DcsTag.parse(t));
            if (!dcsTag) return;

            let path;
            const topic = model.topic;
            if (topic) {
              path = `/t/${topic.slug}/${topic.id}?r=true`;
            } else {
              const isCommentMode = tags.includes("dcs-comment");
              const modeTag = isCommentMode ? "dcs-comment" : "dcs-discuss";
              path = `/tags/intersection/${modeTag}/${dcsTag}?r=true`;
            }
            shrinkComposer = false;
            container.lookup("service:router").transitionTo(path);
          });
        });

        // Handle tags changes in composer
        api.onAppEvent("composer:opened", () => {
          schedule("afterRender", () => {
            const composerController = container.lookup("controller:composer");
            if (!composerController) return;

            const model = composerController.get("model");
            if (!model || !model.get) return;

            const tags = model?.tags;
            const dcsTag = tags?.find((tag) => DcsTag.parse(tag));
            if (!dcsTag) return;

            const isCommentMode = tags.includes("dcs-comment");
            if (isCommentMode) {
              model.setProperties({
                title: discourseAPI.commentTopicTitle(dcsTag),
              });

              // Update composer button text
              schedule("afterRender", () => {
                const button = document.querySelector("#reply-control .save-or-cancel .d-button-label");
                if (button) {
                  button.textContent = "Add Comment";
                }
              });
            }
          });
        });

        // Auto-select "hidden" category when composer opens (Task #3)
        api.onAppEvent("composer:opened", () => {
          schedule("afterRender", () => {
            const composerController = container.lookup("controller:composer");
            if (!composerController) return;

            const model = composerController.get("model");
            if (!model || !model.get) return;

            // Only set category if not already set and if creating a new topic
            const categoryId = model.get("categoryId");
            const action = model.get("action");

            if (!categoryId && action === Composer.CREATE_TOPIC) {
              // Find the "hidden" category
              const appCtrl = container.lookup("controller:application");
              const hiddenCategory = appCtrl.site.categories.find(
                c => c.name.toLowerCase() === "hidden"
              );

              if (hiddenCategory) {
                model.set("categoryId", hiddenCategory.id);
              }
            }
          });
        });
      });
    };

    // Just initialize without trying to create tags
    initializePlugin();
  },
};

const afterRender = (res) =>
  new Promise((resolve) => {
    schedule("afterRender", null, () => resolve(res));
  });
