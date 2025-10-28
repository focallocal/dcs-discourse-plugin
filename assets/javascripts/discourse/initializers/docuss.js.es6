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
  initialize(container) {
    if (!container.lookup("service:site-settings")?.docuss_enabled) return;

    let dcsIFrame;

    const initializePlugin = () => {
      setDefaultHomepage("docuss");

      // Create iframe
      dcsIFrame = new DcsIFrame(container);

      // Wait for rendering
      afterRender().then(() => onAfterRender(container));

      // Add query param
      container.lookup("controller:application")?.reopen({
        queryParams: { showRight: "r" },
        showRight: true,
      });

      // Header logo update
      container.dcsHeaderLogo = {
        _logoUrl: null,
        _mobileLogoUrl: null,
        _smallLogoUrl: null,
        _href: null,
        setLogo(logos) {
          container.dcsHeaderLogo._logoUrl = logos?.logoUrl;
          container.dcsHeaderLogo._mobileLogoUrl = logos?.mobileLogoUrl;
          container.dcsHeaderLogo._smallLogoUrl = logos?.smallLogoUrl;
          container.dcsHeaderLogo._href = logos?.href;

          const updateLogoInDom = () => {
            const header = document.querySelector(".d-header");
            if (!header) return;

            const logoLink = header.querySelector("#site-logo");
            const logoImg = header.querySelector(".logo-big, .logo-small");

            if (logoLink && container.dcsHeaderLogo._href) logoLink.href = container.dcsHeaderLogo._href;
            if (logoImg && container.dcsHeaderLogo._logoUrl) logoImg.src = container.dcsHeaderLogo._logoUrl;

            const headerTitle = header.querySelector(".title");
            if (headerTitle) {
              headerTitle.style.display = "none";
              setTimeout(() => (headerTitle.style.display = ""), 10);
            }
          };

          updateLogoInDom();
          schedule("afterRender", updateLogoInDom);
        },
      };

      let lastUrl = "";
      let shrinkComposer = true;

      withPluginApi("1.2.0", (api) => {
        const handlePageChange = (data) => {
          const currentRouteName = data?.currentRouteName || data?.routeName;
          const url = data?.url || window.location.href;

          if (url === lastUrl) return;
          const queryParamsOnly = url.split("?")[0] === lastUrl.split("?")[0];
          lastUrl = url;

          // ✅ Guard routeName
          if (currentRouteName) {
            onDidTransition({
              container,
              iframe: dcsIFrame,
              routeName: currentRouteName,
              queryParamsOnly,
            });
          }

          container.lookup("controller:composer")?.shrink?.();
          shrinkComposer = true;
        };

        api.onAppEvent("page:changed", handlePageChange);
        api.onPageChange(handlePageChange);

        // Composer opened events
        api.onAppEvent("composer:opened", () => {
          schedule("afterRender", () => {
            const composerController = container.lookup("controller:composer");
            if (!composerController) return;

            const model = composerController.get?.("model");
            if (!model) return;

            const state = model.get?.("composeState");
            if (state !== Composer.OPEN) return;

            // Hidden tags / default category
            const tags = model.tags || (model.topic && model.topic.tags);
            const dcsTag = tags?.find((t) => DcsTag.parse(t));

            if (!dcsTag) return;

            // Default category
            const categoryId = model.get?.("categoryId");
            const action = model.get?.("action");

            if (!categoryId && action === Composer.CREATE_TOPIC) {
              const hiddenCategory = container.lookup("controller:application")?.site?.categories?.find(
                (c) => c.name.toLowerCase() === "hidden"
              );
              if (hiddenCategory) model.set?.("categoryId", hiddenCategory.id);
            }

            // Compute path for iframe
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
            container.lookup("service:router")?.transitionTo?.(path);
          });
        });
      });
    };

    initializePlugin();
  },
};

const afterRender = (res) =>
  new Promise((resolve) => {
    schedule("afterRender", null, () => resolve(res));
  });
