// assets/javascripts/discourse/initializers/docuss.js.es6
import { schedule } from "@ember/runloop";
import { withPluginApi } from "discourse/lib/plugin-api";
import Composer from "discourse/models/composer";

import { DcsIFrame } from "../lib/DcsIFrame";
import { DcsTag } from "../lib/DcsTag";
import { discourseAPI } from "../lib/discourseAPI";
import { onAfterRender } from "../lib/onAfterRender";
import { onDidTransition } from "../lib/onDidTransition";

/*
  Modernized Docuss initializer for Discourse 3.6 / Ember 5 and Plugin API 1.2.0
  - Avoids model.set / model.get
  - Uses api.onPageChange and api.onAppEvent
  - Defers DOM updates to afterRender
  - Defensive guards to avoid throwing and bringing down page handlers
*/

export default {
  name: "docuss",
  initialize(container, app) {
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings?.docuss_enabled) return;

    let dcsIFrame = null;
    let lastUrl = "";
    let shrinkComposer = true;

    const safeScheduleAfterRender = (fn) => {
      try { schedule("afterRender", fn); } catch (e) { console.warn("Docuss schedule failed", e); }
    };

    withPluginApi("1.2.0", (api) => {
      try { dcsIFrame = new DcsIFrame(app, container); } catch (e) { console.warn("Docuss DcsIFrame init failed", e); }

      onAfterRender(container);

      const setHeaderLogo = (logos) => {
        safeScheduleAfterRender(() => {
          try {
            const header = document.querySelector(".d-header");
            if (!header) return;
            const logoLink = header.querySelector("#site-logo");
            const logoImg = header.querySelector(".logo-big, .logo-small");
            if (logoLink && logos?.href) logoLink.href = logos.href;
            if (logoImg && logos?.logoUrl) logoImg.src = logos.logoUrl;
            const headerTitle = header.querySelector(".title");
            if (headerTitle) {
              headerTitle.style.display = "none";
              setTimeout(() => { headerTitle.style.display = ""; }, 10);
            }
          } catch (e) { console.warn("Docuss setHeaderLogo failed", e); }
        });
      };

      container.dcsHeaderLogo = {
        _logos: null,
        setLogo(logos) {
          container.dcsHeaderLogo._logos = logos;
          setHeaderLogo(logos);
        },
      };

      const handlePageChange = (data) => {
        try {
          const currentRouteName = data?.currentRouteName || data?.routeName || null;
          const url = data?.url || (typeof data === "string" ? data : window.location.href);
          if (!url) return;
          if (url === lastUrl) return;

          const queryParamsOnly = lastUrl && (url.split("?")[0] === lastUrl.split("?")[0]);
          lastUrl = url;

          try { onDidTransition({ container, iframe: dcsIFrame, routeName: currentRouteName, queryParamsOnly }); } catch (e) {}
          try {
            const composerCtrl = api.container.lookup("controller:composer");
            if (composerCtrl?.shrink && shrinkComposer) composerCtrl.shrink();
          } catch (e) {}
          shrinkComposer = true;
        } catch (e) { console.warn("Docuss handlePageChange exception", e); }
      };

      try { api.onAppEvent("page:changed", handlePageChange); } catch (e) {}
      try { api.onPageChange(handlePageChange); } catch (e) { console.warn("Docuss api.onPageChange failed", e); }

      safeScheduleAfterRender(() => {
        try {
          const iframeContainer = document.querySelector(".dcs-iframe-container");
          if (iframeContainer) {
            const iframe = iframeContainer.querySelector("iframe");
            if (iframe) {
              const originalUrl = iframe.src || "";
              const proxyUrl = `/proxy?url=${encodeURIComponent(originalUrl)}`;
              const newIframe = document.createElement("iframe");
              newIframe.src = proxyUrl;
              newIframe.setAttribute("sandbox", "allow-same-origin allow-scripts allow-popups allow-forms allow-presentation");
              newIframe.setAttribute("allow", "fullscreen");
              newIframe.style.width = "100%";
              newIframe.style.height = "100%";
              newIframe.style.border = "none";
              newIframe.onerror = () => console.error("Docuss iframe load failed");
              iframe.parentNode.replaceChild(newIframe, iframe);
            }
          }
        } catch (e) { console.warn("Docuss iframe creation failed", e); }
      });

      api.onAppEvent("composer:opened", () => {
        safeScheduleAfterRender(() => {
          try {
            const composerCtrl = api.container.lookup("controller:composer");
            if (!composerCtrl) return;
            const model = composerCtrl.model || composerCtrl.get?.("model");
            if (!model) return;
            if ((model.composeState ?? model.get?.("composeState")) !== Composer.OPEN) return;

            const tags = model.tags || model.topic?.tags || [];
            const dcsTag = tags.find((t) => DcsTag.parse?.(t));
            if (dcsTag) {
              if (model.topic) {
                shrinkComposer = false;
                try { api.container.lookup("service:router").transitionTo(`/t/${model.topic.slug}/${model.topic.id}?r=true`); } catch (e) {}
              } else {
                shrinkComposer = false;
                const isCommentMode = tags.includes("dcs-comment");
                const modeTag = isCommentMode ? "dcs-comment" : "dcs-discuss";
                try { api.container.lookup("service:router").transitionTo(`/tags/intersection/${modeTag}/${dcsTag}?r=true`); } catch (e) {}
              }
            }

            if (tags.includes("dcs-comment")) {
              try { model.title = discourseAPI.commentTopicTitle(dcsTag); } catch (e) {}
              safeScheduleAfterRender(() => {
                const button = document.querySelector("#reply-control .save-or-cancel .d-button-label");
                if (button) button.textContent = "Add Comment";
              });
            }

            const categoryId = model.categoryId ?? model.get?.("categoryId");
            const action = model.action ?? model.get?.("action");
            if (!categoryId && action === Composer.CREATE_TOPIC) {
              const appCtrl = api.container.lookup("controller:application");
              const hiddenCategory = appCtrl?.site?.categories?.find((c) => c.name?.toLowerCase() === "hidden");
              if (hiddenCategory) {
                try { model.categoryId = hiddenCategory.id; } catch (e) {}
              }
            }
          } catch (e) { console.warn("Docuss composer:opened handler failed", e); }
        });
      });

      safeScheduleAfterRender(() => {
        try {
          document.addEventListener("keydown", (ev) => {
            if (ev.altKey && ev.key?.toLowerCase() === "a") {
              try {
                const categorySelect = document.querySelector(".category-chooser, .select-kit");
                const tagBoxes = document.querySelectorAll(".tag-chooser, .tag-row, .tag-box");
                if (categorySelect) categorySelect.style.display = (categorySelect.style.display === "none" || categorySelect.hidden) ? "" : "none";
                if (tagBoxes.length) tagBoxes.forEach(tb => tb.style.display = (tb.style.display === "none" || tb.hidden) ? "" : "none");
              } catch (e) { console.warn("Docuss Alt+A toggle failed", e); }
            }
          });
        } catch (e) { console.warn("Docuss attachAltAToggle failed", e); }
      });

    }); // end withPluginApi
  }, // end initialize
};
