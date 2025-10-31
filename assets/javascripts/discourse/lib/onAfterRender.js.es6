//import { u } from './utils'
import { DcsLayout } from './DcsLayout'
import User from 'discourse/models/user'

//------------------------------------------------------------------------------
export function onAfterRender(container) {
  const appCtrl = container.lookup('controller:application')
  const router = container.lookup('service:router')
  const currentRouteName = router?.currentRouteName
  
  // CRITICAL: Only set up Docuss DOM on actual Docuss routes
  // Check if this is a Docuss route
  const isDocussRoute = currentRouteName && currentRouteName.startsWith('docuss')
  const isTagsIntersection = currentRouteName === 'tags.intersection' || 
                             (currentRouteName?.startsWith('tags') && window.location.pathname.includes('/intersection/'))
  const isDcsRoute = isDocussRoute || isTagsIntersection
  
  console.log('🔧 onAfterRender - Route:', currentRouteName, 'isDcsRoute:', isDcsRoute)
  
  // If NOT on a Docuss route, only add setting classes and return early
  if (!isDcsRoute) {
    console.log('⚠️ Not a Docuss route, skipping DOM creation')
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
    document.documentElement.classList.add(...classes)
    return // EXIT: Don't create Docuss DOM on non-Docuss pages
  }
  
  // ===== ONLY REACHED ON DOCUSS ROUTES =====
  console.log('✓ On Docuss route, creating Docuss DOM')
  
  // Add classes to the <html> tag
  let classes = ['dcs2', 'dcs-map']
  
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
      router.transitionTo({ queryParams: { showRight: showRight } })
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
