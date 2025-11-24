// assets/javascripts/discourse/initializers/docuss.js.es6
import { schedule, later } from "@ember/runloop";
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

    let docussActive = false;
    container.isDocussActive = false;

    const setDocussActive = (active) => {
      const html = document.documentElement;

      if (active) {
        html.classList.remove("dcs-enable-default");
        html.classList.add("dcs2");
        html.classList.add("dcs-map");
      } else {
        html.classList.remove("dcs2", "dcs-map", "dcs-debug");
        html.classList.remove("dcs-enable-default");
        html.classList.remove("dcs-tag", "dcs-topic", "dcs-comment", "dcs-discuss");
        html.removeAttribute("dcs-layout");
        if (docussActive && container.dcsLayout) {
          try {
            container.dcsLayout.setLayout(1);
          } catch (layoutError) {
            console.warn("Failed to reset Docuss layout while deactivating Docuss:", layoutError);
          }
        }
      }

      docussActive = active;
      container.isDocussActive = active;

      console.debug("[Docuss] setDocussActive", {
        active,
        iframeLayout: dcsIFrame?.currentRoute?.layout,
      });
    };

    const syncDocussActiveFromLayout = () => {
      if (!dcsIFrame || !dcsIFrame.currentRoute) {
        return;
      }
      const layout = dcsIFrame.currentRoute?.layout;
      // Layout 0 = iframe only (docuss pages), 2 = split, 3 = split with right panel
      // Layout 1 = Discourse only (non-docuss pages)
      const active = layout === 0 || layout === 2 || layout === 3;
      setDocussActive(active);
    };

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
        // Store in container so splitbar handler can access it
        container.dcsIFrame = dcsIFrame;
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
          const currentUrl = window.location.pathname;
          
          // CRITICAL: Determine if we're on a Docuss route
          // Use URL as primary source since currentRouteName may be null on initial load
          const pathLooksDocuss = currentUrl === "/" || currentUrl === "/docuss" || currentUrl.startsWith("/docuss/");
          const pathLooksTagsIntersection = currentUrl.includes("/tags/intersection/");
          const pathLooksTopic = /^\/t\//.test(currentUrl);
          const isDcsRoute = pathLooksDocuss || pathLooksTagsIntersection || pathLooksTopic;
          
          console.log("Initial route detection:", { currentUrl, pathLooksDocuss, pathLooksTagsIntersection, pathLooksTopic, isDcsRoute });
          
          // Wait for router to be ready before checking route name
          if (dcsIFrame && container.dcsLayout && isDcsRoute) {
            try {
              onDidTransition({
                container,
                iframe: dcsIFrame,
                routeName: currentRouteName,
                queryParamsOnly: false,
              });
              // Sync docussActive state based on the layout that was just set
              syncDocussActiveFromLayout();
            } catch (e) {
              console.warn("Initial onDidTransition failed:", e);
            }
          } else if (!isDcsRoute) {
            // Only set to false if we're definitely NOT on a DCS route
            setDocussActive(false);
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
          // Reset retry count on manual navigation
          if (container._docussRetryCount) {
            console.log('\u27f3 Resetting retry count on navigation')
            container._docussRetryCount = 0
          }
          
          // Clear any pending timers
          if (container._docussConnectionTimer) {
            clearTimeout(container._docussConnectionTimer)
            container._docussConnectionTimer = null
          }
          if (container._docussSpinnerTimer) {
            clearTimeout(container._docussSpinnerTimer)
            container._docussSpinnerTimer = null
          }
          
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
            setDocussActive(false);
            return;
          }

          if (isDcsManagedRoute) {
            if (routeName && dcsIFrame && container.dcsLayout) {
              try {
                console.log("✓ All conditions met, calling onDidTransition for route:", routeName);
                onDidTransition({
                  container,
                  iframe: dcsIFrame,
                  routeName,
                  queryParamsOnly,
                });

                syncDocussActiveFromLayout();

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
                syncDocussActiveFromLayout();
              }
            } else {
              console.log("⚠ Skipping onDidTransition - missing conditions:", {
                hasRoute: !!routeName,
                hasIFrame: !!dcsIFrame,
                hasLayout: !!container.dcsLayout,
                isDcsManagedRoute,
              });
              syncDocussActiveFromLayout();
            }
          } else {
            setDocussActive(false);
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
      // Composer Opened Handler - Auto-select Hidden Category
      // ========================================
      api.onAppEvent("composer:opened", () => {
        schedule("afterRender", () => {
          try {
            const composerCtrl = container.lookup("controller:composer");
            if (!composerCtrl) return;

            const model = composerCtrl.model || composerCtrl.get?.("model");
            if (!model || !model.get) return;

            // Check if composer is actually open
            const composeState = model.get("composeState");
            if (composeState !== Composer.OPEN) return;

            // Only set category if not already set and if creating a new topic
            const categoryId = model.get("categoryId");
            const action = model.get("action");

            if (!categoryId && action === Composer.CREATE_TOPIC) {
              // Check if we're in Docuss mode
              const isDocussActive = container.isDocussActive || document.documentElement.classList.contains("dcs2");
              
              if (isDocussActive) {
                // Find the "hidden" category
                const appCtrl = container.lookup("controller:application");
                const hiddenCategory = appCtrl?.site?.categories?.find(
                  c => c && c.name && c.name.toLowerCase() === "hidden"
                );

                if (hiddenCategory) {
                  model.set("categoryId", hiddenCategory.id);
                  console.debug("[Docuss] Auto-selected hidden category for new topic", {
                    categoryId: hiddenCategory.id,
                    categoryName: hiddenCategory.name
                  });
                } else {
                  console.warn("[Docuss] Hidden category not found");
                }
              }
            }

            let tags = model.tags || model.topic?.tags || [];
            
            // CRITICAL FIX: When opening composer from tag intersection page,
            // Discourse only pre-fills the primary tag (dcs-discuss), not the intersection tag.
            // We need to manually add the page-specific tag from the current URL.
            if (!model.topic && action === Composer.CREATE_TOPIC) {
              const router = container.lookup("service:router");
              const currentRoute = router?.currentRouteName;
              
              if (currentRoute === "tags.intersection") {
                const route = container.lookup("route:tags.intersection");
                const routeModel = route?.currentModel;
                
                if (routeModel?.additionalTags && routeModel.additionalTags.length > 0) {
                  const intersectionTag = routeModel.additionalTags[0];
                  
                  // Only add if it's a Docuss tag and not already in the array
                  if (DcsTag.parse?.(intersectionTag) && !tags.includes(intersectionTag)) {
                    tags = [...tags, intersectionTag];
                    model.tags = tags;
                    console.debug("[Docuss] Added missing intersection tag to composer", {
                      addedTag: intersectionTag,
                      allTags: tags
                    });
                  }
                }
              }
            }
            
            console.debug("[Docuss] composer opened", {
              composeState,
              tags,
              categoryId: model.categoryId,
              category: model.category,
              navigatedToTag: model.__dcsNavigatedToTag
            });

            const dcsTag = tags.find((t) => DcsTag.parse?.(t));

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

              console.debug("[Docuss] composer navigating to Docuss context", {
                dcsTag,
                path,
                fromExistingTopic: !!model.topic
              });

              shrinkComposer = false;
              model.__dcsNavigatedToTag = true;

              try {
                const router = container.lookup("service:router");
                if (router?.transitionTo) {
                  const currentUrl = router.currentURL || `${window.location.pathname}${window.location.search}`;
                  if (currentUrl !== path) {
                    console.debug("[Docuss] composer initiating router transition", {
                      from: currentUrl,
                      to: path
                    });
                    router.transitionTo(path);
                  }
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
                    console.debug("[Docuss] composer updated comment button label");
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

      // ========================================
      // Sidebar Click Handler - Close Docuss when sidebar clicked
      // ========================================
      schedule("afterRender", () => {
        const handleSidebarClick = (event) => {
          // Check if we're in a Docuss layout (split or iframe-only modes)
          const hasDocussLayout = document.documentElement.classList.contains("dcs2");
          if (!hasDocussLayout) return;

          // Check if click is on sidebar or its children
          const sidebar = event.target.closest(".sidebar-wrapper, .sidebar-sections, .sidebar-section-link");
          if (!sidebar) return;

          // Don't interfere with clicks on DCS links
          if (event.target.closest(".dcs-link-icons")) return;

          // Close Docuss by navigating to the clicked topic/category without Docuss params
          try {
            const router = container.lookup("service:router");
            if (!router) return;

            const currentUrl = window.location.href;
            const url = new URL(currentUrl);
            
            // Check if we have Docuss query params
            const hasDcsParams = url.searchParams.has('dcs-trigger-id') || 
                                 url.searchParams.has('dcs-layout') ||
                                 url.searchParams.has('dcs-interact-mode');
            
            if (hasDcsParams) {
              // Remove all Docuss params
              url.searchParams.delete('dcs-layout');
              url.searchParams.delete('dcs-interact-mode');
              url.searchParams.delete('dcs-trigger-id');
              
              const newPath = url.pathname + url.search;
              console.debug("[Docuss] Sidebar clicked, closing Docuss:", { from: currentUrl, to: newPath });
              
              router.transitionTo(newPath);
            }
          } catch (e) {
            console.warn("Failed to handle sidebar click:", e);
          }
        };

        // Add click listener to document
        document.addEventListener("click", handleSidebarClick, true);
        console.log("✓ Registered sidebar click handler");
      });

      api.onAppEvent("composer:closed", () => {
        try {
          const composerCtrl = container.lookup("controller:composer");
          const model = composerCtrl?.model;
          if (model && model.__dcsNavigatedToTag) {
            delete model.__dcsNavigatedToTag;
          }
        } catch (e) {
          console.warn("Failed to reset Docuss composer state:", e);
        }
      });
    });
  },
};