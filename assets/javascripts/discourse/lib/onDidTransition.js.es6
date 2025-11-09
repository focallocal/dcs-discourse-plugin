import { u } from './utils'
import { DcsTag } from './DcsTag'
import User from 'discourse/models/user'

//------------------------------------------------------------------------------

export function onDidTransition({
  container,
  iframe,
  routeName,
  queryParamsOnly
}) {
  console.log('🔄 onDidTransition called with route:', routeName, 'queryParamsOnly:', queryParamsOnly)
  iframe
    .readyForTransitions()
    .then(() => {
      console.log('✓ iframe ready, calling onDidTransition2')
      onDidTransition2({ container, iframe, queryParamsOnly, routeName })
    })
    .catch(e => {
      console.error('❌ iframe.readyForTransitions failed:', e)
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

  if (routeName.startsWith('topic.')) {
    const route = container.lookup('route:topic')
    const model = route['currentModel']
    // Wait for the "tags" field. The "tags" field is not always there
    // immediately, especially when creating a new topic
    // 15x200 = 3s total. Tried 1,5s before -> not enough.
    const hasTagsProp = () => model.hasOwnProperty('tags')
    u.async.retryDelay(hasTagsProp, 15, 200).then(
      () => {
        onDidTransition3({ container, iframe, routeName, queryParamsOnly })
      },
      () => {
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

  //**** Docuss routes ****
  if (routeName.startsWith('docuss')) {
    const route = container.lookup('route:' + routeName)
    const context = route['context'] || {}
    const dcsRoute = { layout: 0, pageName: context['page'] } // Here pageName can be empty
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
        container.dcsLayout.setLayout(layout)
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
      const layout = container.dcsLayout.getShowRightQP() ? 3 : 2
      
      // Extract avatar template from topic creator
      const createdBy = model.details?.created_by
      const avatarTemplate = createdBy?.avatar_template
      
      const dcsRoute = { 
        layout, 
        pageName, 
        triggerId, 
        interactMode,
        // Add topic data including avatar
        topic: {
          id: model.id,
          title: model.title,
          userId: createdBy?.id,
          username: createdBy?.username,
          avatarTemplate: avatarTemplate
        }
      }
      const hasRedirected = iframe.didTransition(dcsRoute)
      if (hasRedirected) {
        return
      }
      if (!queryParamsOnly) {
        const modeClass = isCommentMode ? 'dcs-comment' : 'dcs-discuss'
        document.documentElement.classList.remove('dcs-tag', 'dcs-topic', 'dcs-comment', 'dcs-discuss')
        document.documentElement.classList.add('dcs-topic', modeClass)
        afterRender().then(() => modifyTopicPage(dcsTag, isCommentMode))
      }
      container.dcsLayout.setLayout(layout)
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
