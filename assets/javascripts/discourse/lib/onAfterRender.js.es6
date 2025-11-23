//import { u } from './utils'
import { DcsLayout } from './DcsLayout'
import User from 'discourse/models/user'

//------------------------------------------------------------------------------
export function onAfterRender(container) {
  const appCtrl = container.lookup('controller:application')
  const initialRouterService = (() => {
    try {
      return container.lookup('service:router')
    } catch (e) {
      return null
    }
  })()
  
  // NOTE: DO NOT add/remove dcs2 class here!
  // Route may not be ready yet during initial render
  // The initializer handles class management based on route changes
  // This function ONLY creates the DOM structure needed by Docuss
  
  // Add Docuss-specific setting classes (not route-dependent)
  let classes = []
  
  if (appCtrl.siteSettings['docuss_hide_sugg_topics']) {
    classes.push('dcs-disable-sugg')
  }
  if (appCtrl.siteSettings['docuss_hide_categories']) {
    classes.push('dcs-disable-cats')
  }
  if (appCtrl.siteSettings['docuss_hide_hamburger_menu']) {
    classes.push('dcs-no-ham-menu')
  }
  if (appCtrl.siteSettings['docuss_hide_tags']) {
    classes.push('dcs-hide-tags')
  }
  
  // Add classes to HTML element
  document.documentElement.classList.add(...classes)
  
  // Create and prepend elements to body
  const ghostDiv = document.createElement('div')
  ghostDiv.id = 'dcs-ghost'
  ghostDiv.innerHTML = '<div class="dcs-ghost-splitbar"></div>'
  
  const containerDiv = document.createElement('div')
  containerDiv.id = 'dcs-container'
  containerDiv.innerHTML = `
    <div id="dcs-ios-wrapper">
      <div id="dcs-left"></div>
    </div>
    <div id="dcs-splitbar">
      <div style="flex:1 0 0"></div>
      <div id="dcs-splitbar-text">&gt;</div>
      <div style="flex:1 0 0"></div>
    </div>
  `
  
  document.body.insertBefore(ghostDiv, document.body.firstChild)
  document.body.insertBefore(containerDiv, document.body.firstChild)
  
  // Wrap #main-outlet-wrapper in #dcs-right
  const mainOutletWrapper = document.getElementById('main-outlet-wrapper')
  if (mainOutletWrapper) {
    const rightDiv = document.createElement('div')
    rightDiv.id = 'dcs-right'
    mainOutletWrapper.parentNode.insertBefore(rightDiv, mainOutletWrapper)
    rightDiv.appendChild(mainOutletWrapper)
  }

  // Prevent scrolling of the Discourse page (right) when scrolling in iframe
  // reaches top / bottom.
  // Notice that the "scroll" events fires *after* scrolling has been done.
  // DRAWBACK:
  // - makes the right page to "vibrate",
  // - doesn't work if the scrolls with his keyboard (up, down, page up, page
  // down) while the iframe has the focus but the mouse cursor is over the right
  // panel.
  // For reference, although those solutions don't work:
  // https://stackoverflow.com/questions/32165246/prevent-parent-page-from-scrolling-when-mouse-is-over-embedded-iframe-in-firefox
  // https://stackoverflow.com/questions/5802467/prevent-scrolling-of-parent-element-when-inner-element-scroll-position-reaches-t
  // An idea I did not investigate: within the iframe, in the dcs-client code,
  // catch [wheel, keydown, touchmove] events and, if position is past
  // top / bottom, cancel the scroll.This should prevent bubbling to the parent
  // window.
  /* DOESN'T WORK ON MOBILE !!!!!!!!!!!!!!!!!
  With touch screens, it seems $('#dcs-container:hover').length is always truly.
  if (!appCtrl.site.mobileView) {
    const scrollMem = { left: 0, top: 0 }
    window.addEventListener('scroll', function(e) {
      // If mouse is over #dcs-container...
      if ($('#dcs-container:hover').length) {
        window.scrollTo(scrollMem.left, scrollMem.top)
      } else {
        scrollMem.left = window.scrollX
        scrollMem.top = window.scrollY
      }
    })
  }
  */

  container.dcsLayout = new DcsLayout(appCtrl)
  
  // Set the click handler for the split bar
  const splitbar = document.getElementById('dcs-splitbar')
  if (splitbar) {
    splitbar.addEventListener('click', () => {
      const showRight = !container.dcsLayout.getShowRightQP()
      
      try {
        const routerService = initialRouterService?.transitionTo
          ? initialRouterService
          : container.lookup?.('service:router')
        
        // Check if we're on a topic route (layout 3)
        // If so, clicking the slider should close Docuss entirely by navigating away
        const currentRouteName = routerService?.currentRouteName || routerService?.currentRoute?.name
        
        if (currentRouteName && currentRouteName.startsWith('topic.') && !showRight) {
          // User is on a topic and wants to close Docuss (showRight will become false)
          // Navigate to the tags intersection page to close the topic
          const dcsIFrame = container.dcsIFrame
          if (dcsIFrame && dcsIFrame.currentRoute) {
            const pageName = dcsIFrame.currentRoute.pageName
            const triggerId = dcsIFrame.currentRoute.triggerId
            if (pageName && triggerId) {
              // Navigate back to the tags intersection page
              const tagIntersectionUrl = `/tags/intersection/dcs-discuss/dcs-m_3f-${triggerId}`
              if (routerService?.transitionTo) {
                routerService.transitionTo(tagIntersectionUrl)
                return
              }
            }
          }
          // Fallback: try to go to /latest or homepage
          if (routerService?.transitionTo) {
            routerService.transitionTo('/latest')
            return
          }
        }
        
        // Normal case: just toggle the showRight query param
        if (routerService?.transitionTo) {
          routerService.transitionTo({ queryParams: { showRight } })
          return
        }

        const legacyRouter = container.lookup?.('router:main')
        legacyRouter?.transitionTo?.({ queryParams: { showRight } })
      } catch (e) {
        // Fallback: swallow errors so the slider still toggles layout locally
        console.warn('Docuss splitbar transition failed:', e)
      }
    })
  }
  
  // Set the "a" hotkey for debug display
  const user = User.current()
  const userIsAdmin = user && user['admin']
  if (userIsAdmin) {
    document.addEventListener('keydown', (e) => {
      // Alt+a
      if (e.keyCode === 65 && e.altKey) {
        document.documentElement.classList.toggle('dcs-debug')
      }
      // Alt+b
      if (e.keyCode === 66 && e.altKey) {
        container.dcsLayout.setLayout(1)
      }
    })
  }
}
