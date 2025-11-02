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
    let pendingNavigation = null;

    const routerService = (() => {
      try {
        return container.lookup("service:router");
      } catch (e) {
        return null;
      }
    })();

    const normalizeUrl = (value) => {
      if (!value) {
        return "";
      }

      try {
        return new URL(value, window.location.origin).href;
      } catch (e) {
        return value;
      }
    };

    const stripQuery = (value) => {
      const idx = value.indexOf("?");
      return idx === -1 ? value : value.slice(0, idx);
    };

    const resolveRouteName = (data) => {
      return (
        data?.currentRouteName ??
        data?.routeName ??
        routerService?.currentRouteName ??
        null
      );
    };

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
          const currentUrl = window.location.pathname;
          console.log("Initial route:", currentRouteName, "URL:", currentUrl);
          
          // CRITICAL: Determine if we're on a Docuss route
          // Check multiple conditions to be absolutely sure
          const isDocussRoute = currentRouteName && currentRouteName.startsWith('docuss');
          const isTagsIntersection = currentRouteName === 'tags.intersection' || 
                                     (currentRouteName?.startsWith('tags') && currentUrl.includes('/intersection/'));
          const isDcsRoute = isDocussRoute || isTagsIntersection;
          
          console.log("Route detection:", { isDocussRoute, isTagsIntersection, isDcsRoute, currentRouteName, currentUrl });
          
          if (isDcsRoute) {
            console.log("✓ Initial route IS Docuss - adding dcs2 class");
            document.documentElement.classList.remove('dcs-enable-default');
            document.documentElement.classList.add('dcs2');
            document.documentElement.classList.add('dcs-map');
          } else {
            console.log("✓ Initial route is NOT Docuss - explicitly removing dcs2 class");
            // Explicitly remove to ensure it's not there
            document.documentElement.classList.remove('dcs2');
            document.documentElement.classList.remove('dcs-map');
            document.documentElement.classList.remove('dcs-enable-default');
          }
          
          if (currentRouteName && dcsIFrame && container.dcsLayout && isDcsRoute) {
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

          if (pendingNavigation) {
            console.log("↻ Processing deferred navigation after onAfterRender");
            const payload = pendingNavigation;
            pendingNavigation = null;
            handlePageChange(payload);
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
          let routeName = resolveRouteName(data);
          
          // Extract URL
          const rawUrl =
            data?.url || (typeof data === "string" ? data : window.location.href);
          const normalizedUrl = normalizeUrl(rawUrl);
          const normalizedPath = (() => {
            try {
              return new URL(normalizedUrl).pathname;
            } catch (e) {
              return "";
            }
          })();
          
          if (!normalizedUrl) {
            console.log("⚠ No URL provided, returning");
            return;
          }

          if (!container.dcsLayout || !dcsIFrame) {
            console.log("⚠ Docuss not ready yet, deferring navigation", {
              routeName,
              rawUrl,
            });
            pendingNavigation = {
              currentRouteName: routeName,
              url: normalizedUrl,
            };
            return;
          }

          console.log("handlePageChange called:", { 
            routeName, 
            lastUrl, 
            newUrl: normalizedUrl, 
            urlChanged: normalizedUrl !== lastUrl,
            hasLayout: !!container.dcsLayout,
            hasDcsIFrame: !!dcsIFrame,
            hasDcsLayout: !!container.dcsLayout
          });

          if (normalizedUrl === lastUrl) {
            console.log("⚠ URL unchanged, returning");
            return;
          }

          const queryParamsOnly =
            lastUrl && stripQuery(normalizedUrl) === stripQuery(lastUrl);
          lastUrl = normalizedUrl;

          // Derive fallback routing info using the URL when router events omit names
          const pathLooksDocuss =
            normalizedPath === "/" ||
            normalizedPath === "/docuss" ||
            normalizedPath.startsWith("/docuss/");
          const pathLooksTagsIntersection = normalizedPath.includes("/tags/intersection/");
          const pathLooksTopic = /^\/t\//.test(normalizedPath);

          if (!routeName) {
            if (pathLooksDocuss) {
              routeName = normalizedPath.startsWith("/docuss/")
                ? "docuss-with-page"
                : "docuss";
            } else if (pathLooksTagsIntersection) {
              routeName = "tags.intersection";
            } else if (pathLooksTopic) {
              routeName = "topic.fromParams";
            }
          }

          const isDocussRoute = routeName?.startsWith('docuss') || pathLooksDocuss;
          const isTagsIntersection =
            routeName === 'tags.intersection' ||
            (routeName?.startsWith('tags') && normalizedPath.includes('/intersection/')) ||
            pathLooksTagsIntersection;
          const isTopicRoute = routeName?.startsWith('topic.') || pathLooksTopic;
          const isDcsManagedRoute = isDocussRoute || isTagsIntersection || isTopicRoute;
          const isAdminRoute = routeName?.startsWith('admin') || normalizedPath.startsWith('/admin');

          if (isAdminRoute) {
            if (container.dcsLayout) {
              container.dcsLayout.setLayout(1);
            }
            return;
          }

          if (routeName && dcsIFrame && container.dcsLayout && isDcsManagedRoute) {
            try {
              console.log("✓ All conditions met, calling onDidTransition for route:", routeName);
              onDidTransition({
                container,
                iframe: dcsIFrame,
                routeName,
                queryParamsOnly,
              });

              const sidebarService = container.lookup("service:sidebar");
              if (sidebarService) {
                const iframeLayout = dcsIFrame?.currentRoute?.layout;
                const shouldCloseSidebar =
                  iframeLayout !== undefined
                    ? iframeLayout !== 1
                    : (isDocussRoute || isTagsIntersection || isTopicRoute);

                if (shouldCloseSidebar) {
                  try {
                    if (typeof sidebarService.closeSidebar === 'function') {
                      sidebarService.closeSidebar();
                      console.log("✓ Sidebar closed for Docuss layout");
                    } else if (typeof sidebarService.toggleSidebar === 'function') {
                      sidebarService.toggleSidebar();
                    }
                  } catch (sidebarError) {
                    console.warn("Could not close sidebar:", sidebarError);
                  }
                } else if (typeof sidebarService.openSidebar === 'function') {
                  try {
                    sidebarService.openSidebar();
                    console.log("✓ Sidebar opened (non-Docuss layout)");
                  } catch (sidebarError) {
                    // No-op if sidebar service cannot open
                  }
                }
              }

            } catch (e) {
              console.warn("onDidTransition failed:", e);
            }
          } else {
            console.log("⚠ Skipping onDidTransition - missing conditions:", {
              hasRoute: !!routeName,
              hasIFrame: !!dcsIFrame,
              hasLayout: !!container.dcsLayout,
              isDcsManagedRoute,
            });
            if (container.dcsLayout) {
              container.dcsLayout.setLayout(1);
            }
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
            if (dcsTag && !model.__dcsNavigatedToTag) {
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
                  const currentUrl = router.currentURL || `${window.location.pathname}${window.location.search}`;
                  if (currentUrl !== path) {
                    router.transitionTo(path);
                  }
                }
              } catch (e) {
                console.warn("Failed to navigate:", e);
              }

              model.__dcsNavigatedToTag = true;
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

      // Alt+A toggle is already handled in onAfterRender.js
      // It toggles the dcs-debug class which controls tag/category visibility via CSS
    });
  },
};