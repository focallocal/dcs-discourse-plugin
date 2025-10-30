// assets/javascripts/discourse/initializers/docuss.js.es6
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
    // Check if plugin is enabled via site-settings service
    const siteSettings = container.lookup("service:site-settings");
    if (!siteSettings?.docuss_enabled) {
      return;
    }

    // Set default homepage
    setDefaultHomepage("docuss");

    let dcsIFrame = null;
    let lastUrl = "";
    let shrinkComposer = true;

    withPluginApi("1.2.0", (api) => {
      // Initialize iframe - pass BOTH app and container
      try {
        dcsIFrame = new DcsIFrame(app, container);
      } catch (e) {
        console.error("Failed to initialize DcsIFrame:", e);
        return;
      }

      // Run after-render logic - this creates container.dcsLayout
      schedule("afterRender", () => {
        try {
          onAfterRender(container);
          console.log("✓ onAfterRender completed, dcsLayout ready");
          
          // Trigger initial transition after layout is ready
          const router = container.lookup("service:router");
          const currentRouteName = router?.currentRouteName;
          console.log("Initial route:", currentRouteName);
          
          if (currentRouteName && dcsIFrame) {
            try {
              onDidTransition({
                container,
                iframe: dcsIFrame,
                routeName: currentRouteName,
                queryParamsOnly: false,
              });
            } catch (e) {
              console.warn("Initial onDidTransition failed:", e);
            }
          }
        } catch (e) {
          console.error("onAfterRender failed:", e);
        }
      });

      // Add the 'r' query param for showing right panel
      try {
        const appController = container.lookup("controller:application");
        if (appController) {
          appController.reopen({
            queryParams: { showRight: "r" },
            showRight: true,
          });
        }
      } catch (e) {
        console.warn("Failed to add showRight query param:", e);
      }

      // ========================================
      // Header Logo Management
      // ========================================
      container.dcsHeaderLogo = {
        _logos: null,
        setLogo(logos) {
          this._logos = logos;
          
          const updateLogo = () => {
            try {
              const header = document.querySelector(".d-header");
              if (!header) return;

              const logoLink = header.querySelector("#site-logo");
              const logoImg = header.querySelector(".logo-big, .logo-small");

              if (logoLink && logos?.href) {
                logoLink.href = logos.href;
              }
              if (logoImg && logos?.logoUrl) {
                logoImg.src = logos.logoUrl;
              }

              // Force re-render of header title
              const headerTitle = header.querySelector(".title");
              if (headerTitle) {
                headerTitle.style.display = "none";
                setTimeout(() => {
                  headerTitle.style.display = "";
                }, 10);
              }
            } catch (e) {
              console.warn("Failed to update header logo:", e);
            }
          };

          updateLogo();
          schedule("afterRender", updateLogo);
        },
      };

      // ========================================
      // Page Change Handler
      // ========================================
      const handlePageChange = (data) => {
        try {
          // Extract route name - handle various formats
          const currentRouteName = data?.currentRouteName || data?.routeName || null;
          
          // Extract URL
          const url = data?.url || (typeof data === "string" ? data : window.location.href);
          
          console.log("handlePageChange called:", { 
            currentRouteName, 
            lastUrl, 
            newUrl: url, 
            urlChanged: url !== lastUrl,
            hasLayout: !!container.dcsLayout,
            hasDcsIFrame: !!dcsIFrame,
            hasDcsLayout: !!container.dcsLayout
          });
          
          if (!url) {
            console.log("⚠ No URL provided, returning");
            return;
          }
          
          if (url === lastUrl) {
            console.log("⚠ URL unchanged, returning");
            return;
          }

          const queryParamsOnly = lastUrl && (url.split("?")[0] === lastUrl.split("?")[0]);
          lastUrl = url;

          // Only call onDidTransition if we have routeName, dcsIFrame AND dcsLayout is ready
          if (currentRouteName && dcsIFrame && container.dcsLayout) {
            try {
              console.log("✓ All conditions met, calling onDidTransition for route:", currentRouteName);
              onDidTransition({
                container,
                iframe: dcsIFrame,
                routeName: currentRouteName,
                queryParamsOnly,
              });
              
              // Hide Discourse sidebar when on Docuss map
              const isSidebarService = container.lookup("service:sidebar");
              if (isSidebarService && currentRouteName === "docuss.index") {
                try {
                  // For newer Discourse versions with sidebar service
                  if (typeof isSidebarService.closeSidebar === 'function') {
                    isSidebarService.closeSidebar();
                    console.log("✓ Sidebar closed for docuss.index");
                  } else if (isSidebarService.toggleSidebar && typeof isSidebarService.toggleSidebar === 'function') {
                    // Some versions use toggleSidebar
                    isSidebarService.toggleSidebar();
                  }
                } catch (e) {
                  console.warn("Could not close sidebar:", e);
                }
              }
            } catch (e) {
              console.warn("onDidTransition failed:", e);
            }
          } else {
            console.log("⚠ Skipping onDidTransition - missing conditions:", {
              hasRoute: !!currentRouteName,
              hasIFrame: !!dcsIFrame,
              hasLayout: !!container.dcsLayout,
            });
          }

          // Shrink composer on page change - with better error handling
          if (shrinkComposer) {
            try {
              const composerCtrl = container.lookup("controller:composer");
              // Check if composer exists AND has a model AND is actually OPEN before trying to shrink
              if (composerCtrl?.model && composerCtrl?.shrink) {
                const composeState = composerCtrl.model.composeState || composerCtrl.model.get?.("composeState");
                // Only shrink if composer is not open or is already minimized
                if (composeState !== Composer.OPEN) {
                  composerCtrl.shrink();
                }
              }
            } catch (e) {
              // Don't log this error - it's expected when composer doesn't exist
            }
          }
          shrinkComposer = true;
        } catch (e) {
          console.error("handlePageChange error:", e);
        }
      };

      // Register page change listeners
      api.onAppEvent("page:changed", handlePageChange);
      
      // Also register for navigation-related events
      api.onAppEvent("page:update", handlePageChange);
      api.onAppEvent("composer:created", handlePageChange);
      api.onAppEvent("composer:closed", handlePageChange);
      
      // Hook into router for route change detection
      const router = container.lookup("service:router");
      if (router && typeof router.on === 'function') {
        // For Ember 3+, use the newer router API
        try {
          router.on("routeDidChange", () => {
            console.log("🔄 routeDidChange event fired, currentRoute:", router.currentRouteName);
            handlePageChange({
              currentRouteName: router.currentRouteName,
              url: window.location.href,
            });
          });
          console.log("✓ Registered routeDidChange listener");
        } catch (e) {
          console.warn("Could not register routeDidChange listener:", e);
        }
      }
      
      // Fallback: api.onPageChange for older Ember versions
      if (typeof api.onPageChange === 'function') {
        try {
          api.onPageChange(handlePageChange);
          console.log("✓ Registered onPageChange listener");
        } catch (e) {
          console.warn("Could not register onPageChange listener:", e);
        }
      }

      // ========================================
      // Composer Opened Handler
      // ========================================
      api.onAppEvent("composer:opened", () => {
        schedule("afterRender", () => {
          try {
            const composerCtrl = container.lookup("controller:composer");
            if (!composerCtrl) return;

            const model = composerCtrl.model;
            if (!model) return;

            // Check if composer is actually open
            const composeState = model.composeState || model.get?.("composeState");
            if (composeState !== Composer.OPEN) return;

            // Get tags
            const tags = model.tags || model.topic?.tags || [];
            const dcsTag = tags.find((t) => DcsTag.parse?.(t));

            // ========================================
            // Auto-select Hidden Category
            // ========================================
            const categoryId = model.categoryId || model.get?.("categoryId");
            const action = model.action || model.get?.("action");
            
            if (!categoryId && action === Composer.CREATE_TOPIC) {
              try {
                const appCtrl = container.lookup("controller:application");
                const hiddenCategory = appCtrl?.site?.categories?.find(
                  (c) => c.name?.toLowerCase() === "hidden"
                );
                
                if (hiddenCategory) {
                  model.categoryId = hiddenCategory.id;
                }
              } catch (e) {
                console.warn("Failed to set hidden category:", e);
              }
            }

            // ========================================
            // Handle DcsTag Navigation
            // ========================================
            if (dcsTag) {
              let path;
              
              if (model.topic) {
                // Existing topic - go to topic page
                path = `/t/${model.topic.slug}/${model.topic.id}?r=true`;
              } else {
                // New topic - go to tag intersection
                const isCommentMode = tags.includes("dcs-comment");
                const modeTag = isCommentMode ? "dcs-comment" : "dcs-discuss";
                path = `/tags/intersection/${modeTag}/${dcsTag}?r=true`;
              }

              shrinkComposer = false;
              
              try {
                const router = container.lookup("service:router");
                if (router?.transitionTo) {
                  router.transitionTo(path);
                }
              } catch (e) {
                console.warn("Failed to navigate:", e);
              }
            }

            // ========================================
            // Comment Mode UI Updates
            // ========================================
            if (tags.includes("dcs-comment")) {
              try {
                if (dcsTag && discourseAPI?.commentTopicTitle) {
                  model.title = discourseAPI.commentTopicTitle(dcsTag);
                }
              } catch (e) {
                console.warn("Failed to set comment title:", e);
              }

              schedule("afterRender", () => {
                try {
                  const button = document.querySelector(
                    "#reply-control .save-or-cancel .d-button-label"
                  );
                  if (button) {
                    button.textContent = "Add Comment";
                  }
                } catch (e) {
                  console.warn("Failed to update button text:", e);
                }
              });
            }
          } catch (e) {
            console.error("composer:opened handler error:", e);
          }
        });
      });

      // ========================================
      // Alt+A Toggle for Category/Tags (Admin only)
      // ========================================
      schedule("afterRender", () => {
        try {
          document.addEventListener("keydown", (ev) => {
            if (ev.altKey && ev.key?.toLowerCase() === "a") {
              try {
                const categorySelect = document.querySelector(".category-chooser, .select-kit");
                const tagBoxes = document.querySelectorAll(".tag-chooser, .tag-row, .tag-box");
                
                if (categorySelect) {
                  categorySelect.style.display = 
                    (categorySelect.style.display === "none") ? "" : "none";
                }
                
                tagBoxes.forEach((tb) => {
                  tb.style.display = (tb.style.display === "none") ? "" : "none";
                });
              } catch (e) {
                console.warn("Alt+A toggle failed:", e);
              }
            }
          });
        } catch (e) {
          console.error("Failed to attach Alt+A listener:", e);
        }
      });
    });
  },
};