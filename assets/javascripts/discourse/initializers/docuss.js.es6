import { schedule } from "@ember/runloop";
import { withPluginApi } from "discourse/lib/plugin-api";
import Composer from "discourse/models/composer";

import { DcsIFrame } from "../lib/DcsIFrame";
import { DcsTag } from "../lib/DcsTag";
import { discourseAPI } from "../lib/discourseAPI";
import { onAfterRender } from "../lib/onAfterRender";
import { onDidTransition } from "../lib/onDidTransition";

export default {
  name: "docuss",
  initialize() {
    withPluginApi("1.2.0", (api) => {
      const container = api.container; // safe container for lookups
      const appCtrl = container.lookup("controller:application");

      if (!appCtrl.site.docuss_enabled) return;

      // -------------------------------
      // Create IFrame safely
      // -------------------------------
      const dcsIFrame = new DcsIFrame(api.container);

      // -------------------------------
      // Logo management
      // -------------------------------
      container.dcsHeaderLogo = {
        _logoUrl: null,
        _mobileLogoUrl: null,
        _smallLogoUrl: null,
        _href: null,
        setLogo(logos) {
          this._logoUrl = logos?.logoUrl;
          this._mobileLogoUrl = logos?.mobileLogoUrl;
          this._smallLogoUrl = logos?.smallLogoUrl;
          this._href = logos?.href;

          const updateLogo = () => {
            const header = document.querySelector(".d-header");
            if (!header) return;

            const logoLink = header.querySelector("#site-logo");
            const logoImg = header.querySelector(".logo-big, .logo-small");

            if (logoLink && this._href) logoLink.href = this._href;
            if (logoImg && this._logoUrl) logoImg.src = this._logoUrl;

            // Force rerender
            const headerComponent = header.querySelector(".title");
            if (headerComponent) {
              headerComponent.style.display = "none";
              setTimeout(() => (headerComponent.style.display = ""), 10);
            }
          };

          updateLogo();
          schedule("afterRender", updateLogo);
        },
      };

      // -------------------------------
      // Page change handler
      // -------------------------------
      let lastUrl = "";
      let shrinkComposer = true;

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

      api.onAppEvent("page:changed", handlePageChange);
      api.onPageChange(handlePageChange);

      // -------------------------------
      // Composer opened hooks
      // -------------------------------
      api.onAppEvent("composer:opened", () => {
        schedule("afterRender", () => {
          const composerController = container.lookup("controller:composer");
          if (!composerController) return;

          const model = composerController.model;
          if (!model) return;

          // -------------------------------
          // Auto-select "hidden" category
          // -------------------------------
          if (!model.categoryId && model.action === Composer.CREATE_TOPIC) {
            const hiddenCategory = appCtrl.site.categories.find(
              (c) => c.name.toLowerCase() === "hidden"
            );
            if (hiddenCategory) model.categoryId = hiddenCategory.id;
          }

          // -------------------------------
          // Handle tags & DcsTag logic
          // -------------------------------
          const tags = model.tags || (model.topic && model.topic.tags);
          const dcsTag = tags && tags.find((t) => DcsTag.parse(t));
          if (!dcsTag) return;

          let path;
          if (model.topic) {
            path = `/t/${model.topic.slug}/${model.topic.id}?r=true`;
          } else {
            const isCommentMode = tags.includes("dcs-comment");
            const modeTag = isCommentMode ? "dcs-comment" : "dcs-discuss";
            path = `/tags/intersection/${modeTag}/${dcsTag}?r=true`;
          }
          shrinkComposer = false;
          container.lookup("service:router").transitionTo(path);

          // Update composer button for comment mode
          if (tags.includes("dcs-comment")) {
            model.title = discourseAPI.commentTopicTitle(dcsTag);
            schedule("afterRender", () => {
              const button = document.querySelector(
                "#reply-control .save-or-cancel .d-button-label"
              );
              if (button) button.textContent = "Add Comment";
            });
          }
        });
      });

      // -------------------------------
      // Run post-render logic
      // -------------------------------
      onAfterRender(container);
    });
  },
};
