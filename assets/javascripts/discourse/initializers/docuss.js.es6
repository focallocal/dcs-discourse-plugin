import { observer } from "@ember/object";
import { schedule } from "@ember/runloop";
import ComposerController from "discourse/controllers/composer";
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

      // Hide the header-sidebar-toggle element for now, because it doesn't work on docuss.
      const sidebarToggle = document.querySelector('.header-sidebar-toggle');
      if (sidebarToggle) {
        sidebarToggle.style.display = 'none';
      }

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
          withPluginApi("0.8.30", (api) => {
            api.modifyClass("component:site-header", {
              pluginId: "docuss",
              logoUrl() {
                return container.dcsHeaderLogo._logoUrl || this._super();
              },
              mobileLogoUrl() {
                return container.dcsHeaderLogo._mobileLogoUrl || this._super();
              },
              smallLogoUrl() {
                return container.dcsHeaderLogo._smallLogoUrl || this._super();
              },
              href() {
                return container.dcsHeaderLogo._href || this._super();
              }
            });

            // Force a header refresh
            const header = document.querySelector(".d-header");
            if (header) {
              const headerComponent = header.querySelector(".title");
              if (headerComponent) {
                headerComponent.style.display = "none";
                setTimeout(() => {
                  headerComponent.style.display = "";
                }, 0);
              }
            }
          });
        },
      };

      let lastUrl = "";
      let shrinkComposer = true;
      withPluginApi("0.8.30", (api) => {
        // Page changed event
        api.onAppEvent("page:changed", ({ currentRouteName, title, url }) => {
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

      // Rest of initialization...
      ComposerController.reopen({
        composeStateChanged: observer("model.composeState", function() {
          const state = this.get("model.composeState");
          if (state !== Composer.OPEN) return;

          const model = this.get("model");
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
        }),

        tagsChanged: observer("model.tags", function() {
          const model = this.get("model");
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
              $("#reply-control .save-or-cancel .d-button-label").text(
                "Add Comment"
              );
            });
          }
        }),
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
