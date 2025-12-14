import { u } from './utils'
import { DcsTag } from './DcsTag'
import { ComToClient } from './ComToClient'
import User from 'discourse/models/user'

//------------------------------------------------------------------------------
// Helper functions for connection state management
//------------------------------------------------------------------------------

function showSpinner() {
  let spinner = document.getElementById('dcs-loading-spinner')
  if (!spinner) {
    const left = document.getElementById('dcs-left')
    if (left) {
      spinner = document.createElement('div')
      spinner.id = 'dcs-loading-spinner'
      spinner.innerHTML = '<div class="spinner"></div>'
      left.appendChild(spinner)
    }
  }
  if (spinner) {
    // Use setTimeout to ensure CSS transition triggers
    setTimeout(() => spinner.classList.add('visible'), 10)
  }
}

function hideSpinner() {
  const spinner = document.getElementById('dcs-loading-spinner')
  if (spinner) {
    spinner.classList.remove('visible')
    // Remove after transition completes
    setTimeout(() => {
      if (spinner.parentNode) {
        spinner.parentNode.removeChild(spinner)
      }
    }, 250)
  }
}

// Connection check interval (ms) - how often we check if Bellhop connected
const CONNECTION_CHECK_INTERVAL = 100

// Time before showing spinner (ms) - prevents flicker on fast connections
const SPINNER_DELAY = 300

// Max time to wait for connection (ms) - increased from 2000ms based on timing data
// showing 500-700ms typical but longer on slow mobile connections
const MAX_CONNECTION_WAIT = 3000

// Time before auto-recovery to layout 0 (ms)
const RECOVERY_TIMEOUT = 5000

function waitForConnectionAndSetLayout({ container, iframe, layout, dcsRoute, startTime = null }) {
  // Track when we started waiting
  if (!startTime) {
    startTime = Date.now()
  }
  
  const elapsed = Date.now() - startTime

  // Clear any previous timers
  if (container._docussConnectionTimer) {
    clearTimeout(container._docussConnectionTimer)
    container._docussConnectionTimer = null
  }

  // Success: connection established
  if (ComToClient.isConnected()) {
    console.log(`\u2713 iframe connected after ${elapsed}ms, setting layout ${layout}`)
    hideSpinner()
    container._docussRetryCount = 0
    container.dcsLayout.setLayout(layout)
    delete container._docussPendingLayout
    return
  }

  // Failure: exceeded max wait time
  if (elapsed >= MAX_CONNECTION_WAIT) {
    console.warn(`\u26a0\ufe0f Connection timeout after ${elapsed}ms, applying layout anyway`)
    hideSpinner()
    container._docussRetryCount = 0
    
    // Apply the layout anyway - the iframe content may still load
    container.dcsLayout.setLayout(layout)
    delete container._docussPendingLayout
    
    // Set up a recovery check - if still not connected after more time, recover
    container._docussRecoveryTimer = setTimeout(() => {
      if (!ComToClient.isConnected()) {
        console.warn('\u274c Still not connected, triggering recovery')
        // Try reloading the iframe one more time
        iframe.didTransition(dcsRoute)
      }
    }, RECOVERY_TIMEOUT)
    return
  }

  // Still waiting: store pending state and schedule next check
  console.log(`\u23f3 Waiting for connection (${elapsed}ms / ${MAX_CONNECTION_WAIT}ms)`)
  container._docussPendingLayout = { layout, dcsRoute }
  
  // Show spinner after delay (prevents flicker on fast connections)
  if (elapsed >= SPINNER_DELAY && !container._docussSpinnerShown) {
    showSpinner()
    container._docussSpinnerShown = true
  }

  // Schedule next check
  container._docussConnectionTimer = setTimeout(() => {
    waitForConnectionAndSetLayout({ container, iframe, layout, dcsRoute, startTime })
  }, CONNECTION_CHECK_INTERVAL)
}

//------------------------------------------------------------------------------

export function onDidTransition({
  container,
  iframe,
  routeName,
  queryParamsOnly
}) {
  console.log('🔄 onDidTransition called with route:', routeName, 'queryParamsOnly:', queryParamsOnly)
  
  // ============================================================
  // STATE CLEANUP: Clear any pending state from previous route
  // ============================================================
  // This prevents stale messages from the previous route from
  // affecting the new route. The iframe.didTransition() call will
  // increment the routeSequenceId, invalidating any in-flight messages.
  
  // Clear connection timers
  if (container._docussConnectionTimer) {
    clearTimeout(container._docussConnectionTimer)
    container._docussConnectionTimer = null
  }
  if (container._docussRecoveryTimer) {
    clearTimeout(container._docussRecoveryTimer)
    container._docussRecoveryTimer = null
  }
  
  // Clear pending layout (will be set fresh if needed)
  delete container._docussPendingLayout
  container._docussSpinnerShown = false
  
  // Hide spinner if showing from previous route
  hideSpinner()
  
  // Log timing if enabled
  if (window.dcsTimingLog) {
    window.dcsTimingLog('Route change detected', { routeName, queryParamsOnly })
  }
  
  iframe
    .readyForTransitions()
    .then(() => {
      console.log('✓ iframe ready, calling onDidTransition2')
      if (window.dcsTimingLog) {
        window.dcsTimingLog('iframe ready for transitions', { routeName })
      }
      onDidTransition2({ container, iframe, queryParamsOnly, routeName })
    })
    .catch(e => {
      console.error('❌ iframe.readyForTransitions failed:', e)
      if (window.dcsTimingLog) {
        window.dcsTimingLog('iframe readyForTransitions FAILED', { error: e.message || String(e) })
      }
      if (routeName.startsWith('docuss')) {
        // Show the error page
        container.dcsLayout.setLayout(0)
      } else {
        // Show the normal Discourse
        container.dcsLayout.setLayout(1)
      }
      throw e
    })
}

//------------------------------------------------------------------------------

function onDidTransition2({ container, iframe, routeName, queryParamsOnly }) {
  console.log('📋 onDidTransition2 called with route:', routeName)
  
  // Log timing if enabled
  if (window.dcsTimingLog) {
    window.dcsTimingLog('onDidTransition2 started', { routeName })
  }

  if (routeName.startsWith('topic.')) {
    const route = container.lookup('route:topic')
    const model = route['currentModel']
    // Wait for the "tags" field. The "tags" field is not always there
    // immediately, especially when creating a new topic
    // 25x200 = 5s total. Increased from 3s for slower connections.
    const hasTagsProp = () => model.hasOwnProperty('tags')
    const tagWaitStart = Date.now()
    
    if (window.dcsTimingLog) {
      window.dcsTimingLog('Waiting for tags property', { topicId: model?.id })
    }
    
    u.async.retryDelay(hasTagsProp, 25, 200).then(
      () => {
        const waitTime = Date.now() - tagWaitStart
        if (window.dcsTimingLog) {
          window.dcsTimingLog('Tags property loaded', { waitTimeMs: waitTime, tags: model.tags })
        }
        onDidTransition3({ container, iframe, routeName, queryParamsOnly })
      },
      () => {
        const waitTime = Date.now() - tagWaitStart
        if (window.dcsTimingLog) {
          window.dcsTimingLog('Tags property NOT found (timeout)', { waitTimeMs: waitTime })
        }
        // Property "tags" not found in topic model. This happens when topics
        // have no tags. Show the normal Discourse.
        container.dcsLayout.setLayout(1)
      }
    )
  } else {
    onDidTransition3({ container, iframe, routeName, queryParamsOnly })
  }
}

//------------------------------------------------------------------------------

function onDidTransition3({ container, iframe, routeName, queryParamsOnly }) {
  //console.log('onDidTransition3: ', routeName)
  console.log('📍 onDidTransition3 called with route:', routeName)
  
  if (window.dcsTimingLog) {
    window.dcsTimingLog('onDidTransition3 started', { routeName })
  }

  //**** Docuss routes ****
  if (routeName.startsWith('docuss')) {
    const route = container.lookup('route:' + routeName)
    const context = route['context'] || {}
    
    // FIX: If pageName is empty but URL has a page, extract it from URL
    // This prevents the "homepage flash" when navigating to /docuss/pageName
    // when the route context hasn't been populated yet
    let pageName = context['page']
    if (!pageName && window.location.pathname.startsWith('/docuss/')) {
      // Extract page name from URL: /docuss/m_map -> m_map
      pageName = window.location.pathname.substring('/docuss/'.length).split('/')[0]
      console.log('📍 Extracted pageName from URL:', pageName)
    }
    
    const dcsRoute = { layout: 0, pageName }
    const hasRedirected = iframe.didTransition(dcsRoute)
    if (hasRedirected) {
      return
    }
    document.documentElement.classList.remove('dcs-tag', 'dcs-topic', 'dcs-comment', 'dcs-discuss')
    container.dcsLayout.setLayout(dcsRoute.layout)
    return
  }

  //**** Tag intersection route ****
  if (routeName === 'tags.intersection') {
    const route = container.lookup('route:tags.intersection')
    const model = route['currentModel']
    console.log('🏷️ tags.intersection route detected:', {
      tagId: model?.tag?.id,
      additionalTags: model?.additionalTags,
      allTags: model?.tags
    })
    if (model?.tag?.id === 'dcs-comment' || model?.tag?.id === 'dcs-discuss') {
      const tag = model.additionalTags?.[0]
      console.log('✓ Found dcs mode tag, dcsTag:', tag)
      const parsed = DcsTag.parse(tag)
      if (parsed) {
        console.log('✓ DcsTag parsed:', parsed)
        const { pageName, triggerId } = parsed
        const isCommentMode = model.tag.id === 'dcs-comment'
        const interactMode = isCommentMode ? 'COMMENT' : 'DISCUSS'
        const layout = container.dcsLayout.getShowRightQP() ? 3 : 2
        console.log('→ Setting layout to:', layout, 'for mode:', interactMode)
        const dcsRoute = { layout, pageName, triggerId, interactMode }
        const hasRedirected = iframe.didTransition(dcsRoute)
        if (hasRedirected) {
          console.log('⟲ Route was redirected')
          return
        }
        if (!queryParamsOnly) {
          const modeClass = isCommentMode ? 'dcs-comment' : 'dcs-discuss'
          document.documentElement.classList.remove('dcs-tag', 'dcs-topic', 'dcs-comment', 'dcs-discuss')
          document.documentElement.classList.add('dcs-tag', modeClass)
          afterRender().then(() => modifyTagPage(isCommentMode))
        }
        
        // Check connection state before setting layout
        waitForConnectionAndSetLayout({ container, iframe, layout, dcsRoute })
        return
      } else {
        console.log('⚠️ Failed to parse dcsTag')
      }
    } else {
      console.log('⚠️ Not a dcs-comment/dcs-discuss route, tags are:', model?.tag?.id, model?.additionalTags)
    }
  }

  //**** topic route ****
  if (routeName.startsWith('topic.')) {
    const route = container.lookup('route:topic')
    const model = route['currentModel']
    const tags = model['tags'] || []
    const commentOrDiscuss = tags.find(
      tag => tag === 'dcs-comment' || tag === 'dcs-discuss'
    )
    const dcsTag = tags.find(tag => DcsTag.parse(tag))
    if (commentOrDiscuss && dcsTag) {
      const { pageName, triggerId } = DcsTag.parse(dcsTag)
      const isCommentMode = model['tags'].includes('dcs-comment')
      const interactMode = isCommentMode ? 'COMMENT' : 'DISCUSS'
      
      // Check URL for r parameter to determine layout
      const urlParams = new URLSearchParams(window.location.search)
      const rParam = urlParams.get('r')
      let layout
      if (rParam === 'false') {
        layout = 1 // Close Docuss (full client)
      } else if (rParam === 'true') {
        layout = 3 // Discourse only (no iframe)
      } else {
        layout = container.dcsLayout.getShowRightQP() ? 3 : 2 // Default behavior
      }
      
      // Extract avatar template from topic creator
      const createdBy = model.details?.created_by
      const avatarTemplate = createdBy?.avatar_template
      
      // Build the route WITHOUT topic data (for validation)
      const dcsRoute = { 
        layout, 
        pageName, 
        triggerId, 
        interactMode
      }
      
      // Build topic data separately (to be added AFTER didTransition)
      const topicData = {
        id: model.id,
        title: model.title,
        userId: createdBy?.id,
        username: createdBy?.username,
        avatarTemplate: avatarTemplate
      }
      
      const hasRedirected = iframe.didTransition(dcsRoute)
      
      // Add topic data to currentRoute AFTER didTransition (so it doesn't fail validation)
      if (iframe.currentRoute) {
        iframe.currentRoute.topic = topicData
      }
      
      if (hasRedirected) {
        return
      }
      if (!queryParamsOnly) {
        const modeClass = isCommentMode ? 'dcs-comment' : 'dcs-discuss'
        document.documentElement.classList.remove('dcs-tag', 'dcs-topic', 'dcs-comment', 'dcs-discuss')
        document.documentElement.classList.add('dcs-topic', modeClass)
        afterRender().then(() => modifyTopicPage(dcsTag, isCommentMode))
      }
      
      // Check connection state before setting layout
      waitForConnectionAndSetLayout({ container, iframe, layout, dcsRoute })
      return
    }
  }

  //**** Other routes ****
  document.documentElement.classList.remove('dcs-tag', 'dcs-topic', 'dcs-comment', 'dcs-discuss')
  const layout = 1
  const dcsRoute = { layout, pathname: location.pathname }
  const hasRedirected = iframe.didTransition(dcsRoute)
  if (hasRedirected) {
    return
  }
  container.dcsLayout.setLayout(layout)
}

//------------------------------------------------------------------------------

function modifyTagPage(commentMode) {
  // Add the title
  /*
  const navContainer = document.querySelector('.navigation-container')
  if (navContainer) {
    const ul = document.createElement('ul')
    ul.className = 'nav nav-pills dcs-tag-title'
    ul.innerHTML = `<li><a style="pointer-events:none">${commentMode ? 'Comments' : 'Discussions'}</a></li>`
    navContainer.insertBefore(ul, navContainer.firstChild)
  }
  */

  // Change the "New Topic" button to "New Comment"
  if (commentMode) {
    const button = document.querySelector('#create-topic > .d-button-label')
    if (button) {
      button.textContent = 'New Comment'
    }
  }

  // Change the "There are no latest topics. Browse all categories or view
  // latest topics" message when there is no topic
  const footer = document.querySelector('footer.topic-list-bottom')
  if (footer) {
    let html = `
      <div style="margin-left:12px">
        <p><i>No ${commentMode ? 'comment' : 'topic'} yet</i></p>
      `
    if (!User.current()) {
      html += `<p>(you need to log in before you can create one)</p>`
    }
    html += `</div>`
    footer.innerHTML = html

    // Hide the notifications button, because it doesn't work on empty tags
    const notificationBtn = document.querySelector('.tag-notifications-button')
    if (notificationBtn) {
      notificationBtn.style.display = 'none'
    }
  }
}

//------------------------------------------------------------------------------

function modifyTopicPage(dcsTag, commentMode) {
  if (commentMode) {
    // Move the topic-map on top
    // const topicMap = document.querySelector('.topic-map')
    // const post1 = document.querySelector('#post_1 .topic-body')
    // if (topicMap && post1) {
    //   post1.insertBefore(topicMap, post1.firstChild)
    // }
    
    /*
    // Add the title
    const mainOutlet = document.querySelector('#main-outlet')
    if (mainOutlet) {
      const h2 = document.createElement('h2')
      h2.id = 'dcs-comment-title'
      h2.style.cssText = 'margin-bottom:3rem; margin-left:10px'
      h2.textContent = 'Comments'
      mainOutlet.insertBefore(h2, mainOutlet.firstChild)
    }
    */
  } else {
    // Add the "back" link
    // WARNING: if we already were on a dcs topic page, the "back"
    // link is already there. This happens when using the "Suggested Topics" list
    // at the bottom on a topic (admin mode only, I think)
    if (!document.querySelector('#dcs-back')) {
      const categoryDiv = document.querySelector('#main-outlet > .ember-view[class*="category-"]')
      if (categoryDiv) {
        const backDiv = document.createElement('div')
        backDiv.id = 'dcs-back'
        backDiv.className = 'list-controls'
        backDiv.innerHTML = `
          <div class="container">
            <a style="line-height:28px" href="/tags/intersection/dcs-discuss/${dcsTag}">
              &#8630; Back to topic list
            </a>
          </div>
        `
        categoryDiv.insertBefore(backDiv, categoryDiv.firstChild)
      }
    }
  }
}

//------------------------------------------------------------------------------

/*
// CAREFUL: when redirecting a route change (for example within willTransition),
// always use the same method as the original transition, otherwise strange bugs
// occur. For example, if in a transitionTo() you redirect with replaceWith(),
// you erase the previous entry in the browser history !
function redirect(container, transition, ...args) {
  // Don't use transition.router here, it is wrong (or not the right one)
  const router = container.lookup('router:main')
  const fun =
    transition.urlMethod === 'replace'
      ? router.replaceWith
      : router.transitionTo
  return fun.bind(router)(...args)
}
*/
//------------------------------------------------------------------------------

import { schedule } from '@ember/runloop'

const afterRender = res =>
  new Promise(resolve => {
    schedule('afterRender', null, () => resolve(res))
  })

//------------------------------------------------------------------------------
