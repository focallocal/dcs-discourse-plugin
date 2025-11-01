import { u } from './utils'

export class DcsLayout {
  constructor(appCtrl) {
    this.appCtrl = appCtrl
    // Delay mobileView check to avoid deprecation warning
    this.saveMobileView = null
    this.left = document.getElementById('dcs-left')
    this.ghost = document.getElementById('dcs-ghost')
    this.prevLayout = null
  }

  getShowRightQP() {
    return this.appCtrl.get('showRight')
  }

  replaceLeftWithDiv(html) {
    const oldLeft = this.left
    const newDiv = document.createElement('div')
    newDiv.id = 'dcs-left'
    newDiv.style.cssText = oldLeft.style.cssText
    newDiv.innerHTML = `<div style="padding:20px">${html}</div>`
    
    oldLeft.parentNode.replaceChild(newDiv, oldLeft)
    this.left = document.getElementById('dcs-left')
  }

  replaceLeftWithIFrame(src) {
    const oldLeft = this.left
    const additionalAttr = this.appCtrl.siteSettings['docuss_iframe_attributes']
    
    const iframe = document.createElement('iframe')
    iframe.id = 'dcs-left'
    iframe.frameBorder = '0'
    iframe.style.cssText = oldLeft.style.cssText
    iframe.src = src
    
    // Set additional attributes if provided
    if (additionalAttr) {
      const attrs = additionalAttr.split(' ')
      attrs.forEach(attr => {
        const [key, value] = attr.split('=')
        if (key && value) {
          iframe.setAttribute(key, value.replace(/"/g, ''))
        }
      })
    }
    
    oldLeft.parentNode.replaceChild(iframe, oldLeft)
    this.left = document.getElementById('dcs-left')
  }

  _animateGhost(leftStart, leftEnd, onFinish) {
    if (this.ghost.animate) {
      // Case the browser supports the Web Animation API
      const anim = this.ghost.animate(
        [{ left: leftStart }, { left: leftEnd }],
        { duration: 200 }
      )
      if (onFinish) {
        anim.onfinish = onFinish
      }
    } else {
      onFinish && onFinish()
    }
  }

  _animateGhostRL(onFinish) {
    const end = isWideScreen() ? '50%' : '0%'
    this._animateGhost('100%', end, onFinish)
  }

  _animateGhostLR() {
    const start = isWideScreen() ? '50%' : '0%'
    this._animateGhost(start, '100%')
  }

  setLayout(layout) {
    const html = document.documentElement
    
    switch (this.prevLayout) {
      case null:
        html.setAttribute('dcs-layout', layout)
        break

      case 0:
        switch (layout) {
          case 0:
            break
          case 1:
            html.setAttribute('dcs-layout', layout)
            break
          case 2:
            html.setAttribute('dcs-layout', layout)
            break
          case 3:
            this._animateGhostRL(() => {
              html.setAttribute('dcs-layout', layout)
            })
            break
        }
        break

      case 1:
        switch (layout) {
          case 0:
          case 2:
          case 3:
            html.setAttribute('dcs-layout', layout)
            break
          case 1:
            break
        }
        break

      case 2:
        switch (layout) {
          case 0:
          case 1:
            html.setAttribute('dcs-layout', layout)
            break
          case 2:
            break
          case 3:
            this._animateGhostRL(() => {
              html.setAttribute('dcs-layout', layout)
            })
            break
        }
        break

      case 3:
        switch (layout) {
          case 0:
            html.setAttribute('dcs-layout', layout)
            this._animateGhostLR()
            break
          case 1:
            html.setAttribute('dcs-layout', layout)
            break
          case 2:
            html.setAttribute('dcs-layout', layout)
            this._animateGhostLR()
            break
          case 3:
            break
        }
        break

      default:
        u.throw()
    }

    // Check mobileView at runtime instead of during initialization
    if (this.saveMobileView === null) {
      this.saveMobileView = this.appCtrl.site.mobileView || false
    }
    // NOTE: In Discourse 3.6/Ember 6, mobileView is a getter-only property and cannot be set
    // const forceMobileView = this.saveMobileView || layout === 2 || layout === 3
    // this.appCtrl.site.set('mobileView', forceMobileView)

    this.prevLayout = layout

    if (layout === 1) {
      html.classList.remove('dcs2')
      html.classList.remove('dcs-map')
    } else {
      html.classList.add('dcs2')
      html.classList.add('dcs-map')
    }
  }
}

//------------------------------------------------------------------------------

function isWideScreen() {
  return window.innerWidth >= 1035
}

function setWideClass() {
  document.documentElement.classList.toggle('dcs-wide', isWideScreen())
}

window.addEventListener('resize', setWideClass)
setWideClass()
