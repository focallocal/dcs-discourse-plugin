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
    if (!container.lookup("service:site-settings").docuss_enabled) {
      return;
    }

    let dcsIFrame;

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

      container.dcsHeaderLogo = {
        _logoUrl: null,
        _mobileLogoUrl: null,
        _smallLogoUrl: null,
        _href: null,
        setLogo(logos) {
          // Store new values
          container.dcsHeaderLogo._logoUrl = logos?.logoUrl;
          container.dcsHeaderLogo._mobileLogoUrl = logos?.mobileLogoUrl;
          container.dcsHeaderLogo._smallLogoUrl = logos?.smallLogoUrl;
          container.dcsHeaderLogo._href = logos?.href;

          // Force header rerender using modern Discourse API
          // Update logo elements directly in DOM as modifyClass is deprecated
          const updateLogoInDom = () => {
            const header = document.querySelector(".d-header");
            if (header) {
              const logoLink = header.querySelector("#site-logo");
              const logoImg = header.querySelector(".logo-big, .logo-small");

              if (logoLink && container.dcsHeaderLogo._href) {
                logoLink.href = container.dcsHeaderLogo._href;
              }

              if (logoImg && container.dcsHeaderLogo._logoUrl) {
                logoImg.src = container.dcsHeaderLogo._logoUrl;
              }

              // Force rerender
              const headerComponent = header.querySelector(".title");
              if (headerComponent) {
                headerComponent.style.display = "none";
                setTimeout(() => {
                  headerComponent.style.display = "";
                }, 10);
              }
            }
          };

          // Run update immediately and schedule for after render
          updateLogoInDom();
          schedule("afterRender", updateLogoInDom);
        },
      };

      let lastUrl = "";
      let shrinkComposer = true;
      withPluginApi("1.2.0", (api) => {
        // Use modern Discourse route change handler
        // Try both old and new event names for compatibility
        const handlePageChange = (data) => {
          const currentRouteName = data.currentRouteName || data.routeName;
          const url = data.url || window.location.href;

          if (url === lastUrl) return;

          const queryParamsOnly = url.split("?")[0] === lastUrl.split("?")[0];
          lastUrl = url;

          onDidTransition({
            container,
            iframe: dcsIFrame,
            routeName: currentRouteName,
            queryParamsOnly,
          });

          if (shrinkComposer) {
            container.lookup("controller:composer")?.shrink();
          }
          shrinkComposer = true;
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
            if (!model) return;

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
            if (!model) return;

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
