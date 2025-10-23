import Component from "@ember/component";
import { getOwner } from "discourse-common/lib/get-owner";
import { schedule } from "@ember/runloop";

export default Component.extend({
  classNames: ["dcs-layout"],
  
  init() {
    this._super(...arguments);
    this._setupEventListeners();
  },

  willDestroyElement() {
    this._super(...arguments);
    this._cleanupEventListeners();
  },

  _setupEventListeners() {
    try {
      // Store listeners for cleanup
      this._eventListeners = new Set();
      
      const addListener = (element, event, handler) => {
        element.addEventListener(event, handler);
        this._eventListeners.add(() => element.removeEventListener(event, handler));
      };

      // Mobile view handling
      const appCtrl = getOwner(this).lookup("controller:application");
      if (appCtrl?.site && typeof appCtrl.site.setProperties === "function") {
        schedule("afterRender", () => {
          appCtrl.site.setProperties({ mobileView: this.forceMobileView });
        });
      }

      // Add other event listeners here
      // Store cleanup functions in this._eventListeners

    } catch (err) {
      console.error("Error setting up DcsLayout event listeners:", err);
    }
  },

  _cleanupEventListeners() {
    try {
      // Clean up all registered event listeners
      if (this._eventListeners) {
        this._eventListeners.forEach(cleanup => cleanup());
        this._eventListeners.clear();
      }
    } catch (err) {
      console.error("Error cleaning up DcsLayout event listeners:", err);
    }
  }
});