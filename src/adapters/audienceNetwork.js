/**
 * @file Audience Network <==> prebid.js adaptor
 */


let events = require('../events');
let bidmanager = require('../bidmanager');
let bidfactory = require('../bidfactory');
let utils = require('../utils');
let CONSTANTS = require('../constants.json');

let AudienceNetworkAdapter = function AudienceNetworkAdapter() {
  "use strict";

  /**
   * Request the specified bids from Audience Network
   * @param {Object} params the bidder-level params (from prebid)
   * @param {Array} params.bids the bids requested
   */
  function _callBids(params) {

    if (!params.bids && params.bids[0]) {
      // no bids requested
      return;
    }

    let getPlacementSize = function(bid, warn = false){
      let adWidth = 0, adHeight = 0;
      let sizes = bid.sizes || {};

      if (sizes.length === 2 &&
          typeof sizes[0] === 'number' &&
          typeof sizes[1] === 'number') {
        // The array contains 1 size (the items are the values)
        adWidth = sizes[0];
        adHeight = sizes[1];
      } else if (sizes.length >= 1) {
        // The array contains array of sizes, use the first size
        adWidth = sizes[0][0];
        adHeight = sizes[0][1];

        if (warn && sizes.length > 1) {
          utils.logInfo(
            `AudienceNetworkAdapter supports only one size per ` +
            `impression, but ${sizes.length} sizes passed for ` +
            `placementId ${bid.params.placementId}. Using first only.`
          );
        }
      }
      return {height: adHeight, width: adWidth};
    };

    let getPlacementWebAdFormat = function(bid) {
      if (bid.params.native) {
        return 'native';
      }
      if (bid.params.fullwidth) {
        return 'fullwidth';
      }

      let size = getPlacementSize(bid);
      if (
        (size.width === 320 && size.height === 50) ||
        (size.width === 300 && size.height === 250) ||
        (size.width === 728 && size.height === 90)
      ) {
        return `${size.width}x${size.height}`;
      }
    };

    let getTagVersion = function() {
      const tagVersion = params.bids[0].params.tagVersion;
      if (Array.isArray(tagVersion)) {
        return tagVersion[Math.floor(Math.random() * tagVersion.length)];
      }
      return tagVersion || '5.3.web';
    };

    const tagVersion = getTagVersion();
    let url = `https://an.facebook.com/v2/placementbid.json?sdk=${tagVersion}&`;

    let wwwExperimentChance = Number(params.bids[0].params.wwwExperiment);
    if (
      wwwExperimentChance > 0 &&
      wwwExperimentChance <= 100 &&
      Math.floor(Math.random() * wwwExperimentChance) === 0
    ) {
      url = url.replace('an.facebook.com', 'www.facebook.com/an');
    }

    let adPlacementIdToBidMap = new Map();
    for (let pbjsBidReq of params.bids) {
      if (adPlacementIdToBidMap[pbjsBidReq.params.placementId] === undefined) {
        adPlacementIdToBidMap[pbjsBidReq.params.placementId] = [];
      }
      adPlacementIdToBidMap[pbjsBidReq.params.placementId].push(pbjsBidReq);

      url +=
        `placementids[]=${encodeURIComponent(pbjsBidReq.params.placementId)}&` +
        `adformats[]=${encodeURIComponent(getPlacementWebAdFormat(pbjsBidReq))}&`;
    }
    if (params.bids[0].params.testMode) {
      url += 'testmode=true&';
    }

    let http = new HttpClient();
    const requestTimeMS = new Date().getTime();
    http.get(url, function(response) {
      const placementIDArr = [];
      const anBidRequestId = response.request_id;
      for (let placementId in adPlacementIdToBidMap) {
        let anBidArr = response.bids[placementId];
        let anBidReqArr = adPlacementIdToBidMap[placementId];
        for (let idx = 0; idx < anBidReqArr.length; idx++) {
          let pbjsBid = anBidReqArr[idx];

          if (anBidArr === null || anBidArr === undefined ||
            anBidArr[idx] === null || anBidArr[idx] === undefined) {
            let noResponseBidObject = bidfactory.createBid(2);
            noResponseBidObject.bidderCode = params.bidderCode;
            bidmanager.addBidResponse(pbjsBid.placementCode, noResponseBidObject);
            continue;
          }

          let anBid = anBidArr[idx];
          let bidObject = bidfactory.createBid(1);
          bidObject.bidderCode = params.bidderCode;
          bidObject.cpm = anBid.bid_price_cents / 100;
          let size = getPlacementSize(pbjsBid);
          bidObject.width = size.width;
          bidObject.height = size.height;
          bidObject.fbBidId = anBid.bid_id;
          bidObject.fbPlacementId = placementId;
          placementIDArr.push(placementId);
          const format = getPlacementWebAdFormat(pbjsBid);
          bidObject.fbFormat = format;
          bidObject.ad = getTag(tagVersion, placementId, anBid.bid_id, format);
          bidmanager.addBidResponse(pbjsBid.placementCode, bidObject);
        }
      }

      const responseTimeMS = new Date().getTime();
      const bidLatencyMS = responseTimeMS - requestTimeMS;
      const latencySincePageLoad = responseTimeMS - performance.timing.navigationStart;
      const existingEvents = events.getEvents();
      const timeout = existingEvents.some(
        event => event.args &&
          event.eventType === CONSTANTS.EVENTS.BID_TIMEOUT &&
          event.args.bidderCode === params.bidderCode);

      let latencyUrl = 'https://an.facebook.com/placementbidlatency.json?';
      latencyUrl += 'bid_request_id=' + anBidRequestId;
      latencyUrl += '&latency_ms=' + bidLatencyMS.toString();
      latencyUrl += '&bid_returned_time_since_page_load_ms=' + latencySincePageLoad.toString();
      latencyUrl += '&timeout=' + timeout.toString();
      for (const placement_id of placementIDArr) {
        latencyUrl += '&placement_ids[]=' + placement_id;
      }

      let httpRequest = new XMLHttpRequest();
      httpRequest.open('GET', latencyUrl, true);
      httpRequest.withCredentials = true;
      httpRequest.send(null);
    });
  }

  let HttpClient = function() {
    this.get = function(aUrl, aCallback) {
      let anHttpRequest = new XMLHttpRequest();
      anHttpRequest.onreadystatechange = function() {
        if (anHttpRequest.readyState === 4 && anHttpRequest.status === 200) {
          let resp = JSON.parse(anHttpRequest.responseText);
          utils.logInfo(`ANAdapter: ${aUrl} ==> ${JSON.stringify(resp)}`);
          aCallback(resp);
        }
      };

      anHttpRequest.open( "GET", aUrl, true );
      anHttpRequest.withCredentials = true;
      anHttpRequest.send( null );
    };
  };

  let getTag = function(tagVersion, placementId, bidId, format) {
    switch (tagVersion) {
      case '5.3.web':
        if (format === 'native') {
          return `
            <html>
              <head>
                <script type="text/javascript">
                  window.onload = function() {
                      if (parent) {
                          var oHead = document.getElementsByTagName("head")[0];
                          var arrStyleSheets = parent.document.getElementsByTagName("style");
                          for (var i = 0; i < arrStyleSheets.length; i++)
                              oHead.appendChild(arrStyleSheets[i].cloneNode(true));
                      }
                  }
                </script>
              </head>
              <body>
                <div style="display:none; position: relative;">
                  <iframe style="display:none;"></iframe>
                  <script type="text/javascript">
                    var data = {
                      placementid: '${placementId}',
                      bidid: '${bidId}',
                      format: '${format}',
                      testmode: false,
                      onAdLoaded: function(element) {
                        console.log('Audience Network [${placementId}] ad loaded');
                        element.style.display = 'block';
                      },
                      onAdError: function(errorCode, errorMessage) {
                        console.log('Audience Network [${placementId}] error (' + errorCode + ') ' + errorMessage);
                      }
                    };
                    (function(w,l,d,t){var a=t();var b=d.currentScript||(function(){var c=d.getElementsByTagName('script');return c[c.length-1];})();var e=b.parentElement;e.dataset.placementid=data.placementid;var f=function(v){try{return v.document.referrer;}catch(e){}return'';};var g=function(h){var i=h.indexOf('/',h.indexOf('://')+3);if(i===-1){return h;}return h.substring(0,i);};var j=[l.href];var k=false;var m=false;if(w!==w.parent){var n;var o=w;while(o!==n){var h;try{m=m||(o.$sf&&o.$sf.ext);h=o.location.href;}catch(e){k=true;}j.push(h||f(n));n=o;o=o.parent;}}var p=l.ancestorOrigins;if(p){if(p.length>0){data.domain=p[p.length-1];}else{data.domain=g(j[j.length-1]);}}data.url=j[j.length-1];data.channel=g(j[0]);data.width=screen.width;data.height=screen.height;data.pixelratio=w.devicePixelRatio;data.placementindex=w.ADNW&&w.ADNW.Ads?w.ADNW.Ads.length:0;data.crossdomain=k;data.safeframe=!!m;var q={};q.iframe=e.firstElementChild;var r='https://www.facebook.com/audiencenetwork/web/?sdk=5.3';for(var s in data){q[s]=data[s];if(typeof(data[s])!=='function'){r+='&'+s+'='+encodeURIComponent(data[s]);}}q.iframe.src=r;q.tagJsInitTime=a;q.rootElement=e;q.events=[];w.addEventListener('message',function(u){if(u.source!==q.iframe.contentWindow){return;}u.data.receivedTimestamp=t();if(this.sdkEventHandler){this.sdkEventHandler(u.data);}else{this.events.push(u.data);}}.bind(q),false);q.tagJsIframeAppendedTime=t();w.ADNW=w.ADNW||{};w.ADNW.Ads=w.ADNW.Ads||[];w.ADNW.Ads.push(q);w.ADNW.init&&w.ADNW.init(q);})(window,location,document,Date.now||function(){return+new Date;});
                  </script>
                  <script type="text/javascript" src="https://connect.facebook.net/en_US/fbadnw.js" async></script>
                  <div class="thirdPartyRoot">
                    <a class="fbAdLink">
                      <div class="fbAdMedia thirdPartyMediaClass"></div>
                      <div class="fbAdSubtitle thirdPartySubtitleClass"></div>
                      <div class="fbDefaultNativeAdWrapper">
                        <div class="fbAdCallToAction thirdPartyCallToActionClass"></div>
                        <div class="fbAdTitle thirdPartyTitleClass"></div>
                      </div>
                    </a>
                  </div>
                </div>
              </body>
            </html>`;
        }
        return `
          <html>
            <body>
              <div style="display:none; position: relative;">
                <iframe style="display:none;"></iframe>
                <script type="text/javascript">
                  var data = {
                    placementid: '${placementId}',
                    format: '${format}',
                    bidid: '${bidId}',
                    testmode: false,
                    onAdLoaded: function(element) {
                      console.log('Audience Network [${placementId}] ad loaded');
                      element.style.display = 'block';
                    },
                    onAdError: function(errorCode, errorMessage) {
                      console.log('Audience Network [${placementId}] error (' + errorCode + ') ' + errorMessage);
                    }
                  };
                  (function(w,l,d,t){var a=t();var b=d.currentScript||(function(){var c=d.getElementsByTagName('script');return c[c.length-1];})();var e=b.parentElement;e.dataset.placementid=data.placementid;var f=function(v){try{return v.document.referrer;}catch(e){}return'';};var g=function(h){var i=h.indexOf('/',h.indexOf('://')+3);if(i===-1){return h;}return h.substring(0,i);};var j=[l.href];var k=false;var m=false;if(w!==w.parent){var n;var o=w;while(o!==n){var h;try{m=m||(o.$sf&&o.$sf.ext);h=o.location.href;}catch(e){k=true;}j.push(h||f(n));n=o;o=o.parent;}}var p=l.ancestorOrigins;if(p){if(p.length>0){data.domain=p[p.length-1];}else{data.domain=g(j[j.length-1]);}}data.url=j[j.length-1];data.channel=g(j[0]);data.width=screen.width;data.height=screen.height;data.pixelratio=w.devicePixelRatio;data.placementindex=w.ADNW&&w.ADNW.Ads?w.ADNW.Ads.length:0;data.crossdomain=k;data.safeframe=!!m;var q={};q.iframe=e.firstElementChild;var r='https://www.facebook.com/audiencenetwork/web/?sdk=5.3';for(var s in data){q[s]=data[s];if(typeof(data[s])!=='function'){r+='&'+s+'='+encodeURIComponent(data[s]);}}q.iframe.src=r;q.tagJsInitTime=a;q.rootElement=e;q.events=[];w.addEventListener('message',function(u){if(u.source!==q.iframe.contentWindow){return;}u.data.receivedTimestamp=t();if(this.sdkEventHandler){this.sdkEventHandler(u.data);}else{this.events.push(u.data);}}.bind(q),false);q.tagJsIframeAppendedTime=t();w.ADNW=w.ADNW||{};w.ADNW.Ads=w.ADNW.Ads||[];w.ADNW.Ads.push(q);w.ADNW.init&&w.ADNW.init(q);})(window,location,document,Date.now||function(){return+new Date;});
                </script>
                <script type="text/javascript" src="https://connect.facebook.net/en_US/fbadnw.js" async></script>
              </div>
            </body>
          </html>`;

      case '5.5.web':
        if (format === 'native') {
          return `
            <html>
              <head>
                <script type="text/javascript">
                  window.onload = function() {
                      if (parent) {
                          var oHead = document.getElementsByTagName("head")[0];
                          var arrStyleSheets = parent.document.getElementsByTagName("style");
                          for (var i = 0; i < arrStyleSheets.length; i++)
                              oHead.appendChild(arrStyleSheets[i].cloneNode(true));
                      }
                  }
                </script>
              </head>
              <body>
                <div style="display:none; position: relative;">
                  <script type="text/javascript">
                    var data = {
                      placementid: '${placementId}',
                      bidid: '${bidId}',
                      format: '${format}',
                      testmode: false,
                      onAdLoaded: function(element) {
                        console.log('Audience Network [${placementId}] ad loaded');
                        element.style.display = 'block';
                      },
                      onAdError: function(errorCode, errorMessage) {
                        console.log('Audience Network [${placementId}] error (' + errorCode + ') ' + errorMessage);
                      }
                    };
                    (function(a,b,c){var d='https://www.facebook.com',e='https://connect.facebook.net/en_US/fbadnw55.js',f={iframeLoaded:true,xhrLoaded:true},g=5,h=a.data,i=0,j=function(ea){if(ea==null)throw new Error();return ea;},k=function(ea){if(ea instanceof HTMLElement)return ea;throw new Error();},l=function(){if(Date.now){return Date.now();}else return +new Date();},m=function(ea){if(++i>g)return;var fa=d+'/audience_network/client_event',ga={cb:l(),event_name:'ADNW_ADERROR',ad_pivot_type:'audience_network_mobile_web',sdk_version:'5.5.web',app_id:h.placementid.split('_')[0],publisher_id:h.placementid.split('_')[1],error_message:ea},ha=[];for(var ia in ga)ha.push(encodeURIComponent(ia)+'='+encodeURIComponent(ga[ia]));var ja=fa+'?'+ha.join('&'),ka=new XMLHttpRequest();ka.open('GET',ja,true);ka.send();},n=function(){if(b.currentScript){return b.currentScript;}else{var ea=b.getElementsByTagName('script');return ea[ea.length-1];}},o=function(ea){try{return ea.document.referrer;}catch(fa){}return '';},p=function(){var ea=a;try{while(ea!=ea.parent){ea.parent.origin;ea=ea.parent;}}catch(fa){}return ea;},q=function(ea){var fa=ea.indexOf('/',ea.indexOf('://')+3);if(fa===-1)return ea;return ea.substring(0,fa);},r=function(ea){return ea.location.href||o(ea);},s=function(ea,fa){if(ea.sdkLoaded)return;var ga=fa.createElement('iframe');ga.name='fbadnw';ga.style.display='none';j(fa.body).appendChild(ga);ga.contentWindow.addEventListener('error',function(event){m(event.message);},false);var ha=ga.contentDocument.createElement('script');ha.src=e;ha.async=true;j(ga.contentDocument.body).appendChild(ha);ea.sdkLoaded=true;},t=function(ea){var fa=/^https?:\\/\\/www\\.google(\\.com?)?.\\w{2,3}$/;return !!ea.match(fa);},u=function(ea){return ea.endsWith('cdn.ampproject.org');},v=function(){var ea=c.ancestorOrigins||[],fa=ea[ea.length-1]||c.origin,ga=ea[ea.length-2]||c.origin;if(t(fa)&&u(ga)){return q(ga);}else return q(fa);},w=function(ea){try{return JSON.parse(ea);}catch(fa){m(fa.message);return null;}},x=function(ea,fa,ga){if(!ea.iframe){var ha=ga.createElement('iframe');ha.src=d+'/audiencenetwork/iframe/';ha.style.display='none';j(ga.body).appendChild(ha);ea.iframe=ha;ea.iframeAppendedTime=l();ea.iframeData={};}fa.iframe=j(ea.iframe);fa.iframeData=ea.iframeData;fa.tagJsIframeAppendedTime=ea.iframeAppendedTime||0;},y=function(ea){var fa=d+'/audiencenetwork/xhr/?sdk=5.5.web';for(var ga in ea)if(typeof ea[ga]!=='function')fa+='&'+ga+'='+encodeURIComponent(ea[ga]);var ha=new XMLHttpRequest();ha.open('GET',fa,true);ha.withCredentials=true;ha.onreadystatechange=function(){if(ha.readyState===4){var ia=w(ha.response);if(ia)ea.events.push({name:'xhrLoaded',source:ea.iframe.contentWindow,data:ia,postMessageTimestamp:l(),receivedTimestamp:l()});}};ha.send();},z=function(ea,fa){var ga=d+'/audiencenetwork/xhriframe/?sdk=5.5.web';for(var ha in fa)if(typeof fa[ha]!=='function')ga+='&'+ha+'='+encodeURIComponent(fa[ha]);var ia=b.createElement('iframe');ia.src=ga;ia.style.display='none';j(b.body).appendChild(ia);fa.iframe=ia;fa.iframeData={};fa.tagJsIframeAppendedTime=l();},aa=function(ea){var fa=function(event){try{var ia=event.data;if(ia.name in f)ea.events.push({name:ia.name,source:event.source,data:ia.data});}catch(ha){}},ga=j(ea.iframe).contentWindow.parent;ga.addEventListener('message',fa,false);},ba=function(ea){if(ea.context)return true;try{return !!JSON.parse(decodeURI(ea.name)).ampcontextVersion;}catch(fa){return false;}},ca=function(ea){var fa=l(),ga=p(),ha=k(n().parentElement),ia=ga!=a.top,ja=ga.$sf&&ga.$sf.ext,ka=r(ga);ga.ADNW=ga.ADNW||{};ga.ADNW.v55=ga.ADNW.v55||{ads:[]};var la=ga.ADNW.v55;s(la,ga.document);var ma={amp:ba(ga),events:[],tagJsInitTime:fa,rootElement:ha,iframe:null,tagJsIframeAppendedTime:la.iframeAppendedTime||0,url:ka,domain:v(),channel:q(r(a)),width:screen.width,height:screen.height,pixelratio:a.devicePixelRatio,placementindex:la.ads.length,crossdomain:ia,safeframe:!!ja,placementid:h.placementid,format:h.format||'300x250',testmode:!!h.testmode,onAdLoaded:h.onAdLoaded,onAdError:h.onAdError};if(h.bidid)ma.bidid=h.bidid;if(ia){z(la,ma);}else{x(la,ma,ga.document);y(ma);}aa(ma);ma.rootElement.dataset.placementid=ma.placementid;la.ads.push(ma);};try{ca();}catch(da){m(da.message||da);throw da;}})(window,document,location);
                  </script>
                  <div class="thirdPartyRoot">
                    <a class="fbAdLink">
                      <div class="fbAdMedia thirdPartyMediaClass"></div>
                      <div class="fbAdSubtitle thirdPartySubtitleClass"></div>
                      <div class="fbDefaultNativeAdWrapper">
                        <div class="fbAdCallToAction thirdPartyCallToActionClass"></div>
                        <div class="fbAdTitle thirdPartyTitleClass"></div>
                      </div>
                    </a>
                  </div>
                </div>
              </body>
            </html>`;
        }
        return `
          <div style="display:none; position: relative;">
            <script type="text/javascript">
              var data = {
                placementid: '${placementId}',
                bidid: '${bidId}',
                format: '${format}',
                testmode: false,
                onAdLoaded: function(element) {
                  console.log('Audience Network [${placementId}] ad loaded');
                  element.style.display = 'block';
                },
                onAdError: function(errorCode, errorMessage) {
                  console.log('Audience Network [${placementId}] error (' + errorCode + ') ' + errorMessage);
                  // PASSBACK goes here
                }
              };
            </script>
            <script>
              (function(a,b,c){var d='https://www.facebook.com',e='https://connect.facebook.net/en_US/fbadnw55.js',f={iframeLoaded:true,xhrLoaded:true},g=5,h=a.data,i=0,j=function(ea){if(ea==null)throw new Error();return ea;},k=function(ea){if(ea instanceof HTMLElement)return ea;throw new Error();},l=function(){if(Date.now){return Date.now();}else return +new Date();},m=function(ea){if(++i>g)return;var fa=d+'/audience_network/client_event',ga={cb:l(),event_name:'ADNW_ADERROR',ad_pivot_type:'audience_network_mobile_web',sdk_version:'5.5.web',app_id:h.placementid.split('_')[0],publisher_id:h.placementid.split('_')[1],error_message:ea},ha=[];for(var ia in ga)ha.push(encodeURIComponent(ia)+'='+encodeURIComponent(ga[ia]));var ja=fa+'?'+ha.join('&'),ka=new XMLHttpRequest();ka.open('GET',ja,true);ka.send();},n=function(){if(b.currentScript){return b.currentScript;}else{var ea=b.getElementsByTagName('script');return ea[ea.length-1];}},o=function(ea){try{return ea.document.referrer;}catch(fa){}return '';},p=function(){var ea=a;try{while(ea!=ea.parent){ea.parent.origin;ea=ea.parent;}}catch(fa){}return ea;},q=function(ea){var fa=ea.indexOf('/',ea.indexOf('://')+3);if(fa===-1)return ea;return ea.substring(0,fa);},r=function(ea){return ea.location.href||o(ea);},s=function(ea,fa){if(ea.sdkLoaded)return;var ga=fa.createElement('iframe');ga.name='fbadnw';ga.style.display='none';j(fa.body).appendChild(ga);ga.contentWindow.addEventListener('error',function(event){m(event.message);},false);var ha=ga.contentDocument.createElement('script');ha.src=e;ha.async=true;j(ga.contentDocument.body).appendChild(ha);ea.sdkLoaded=true;},t=function(ea){var fa=/^https?:\\/\\/www\\.google(\\.com?)?.\\w{2,3}$/;return !!ea.match(fa);},u=function(ea){return ea.endsWith('cdn.ampproject.org');},v=function(){var ea=c.ancestorOrigins||[],fa=ea[ea.length-1]||c.origin,ga=ea[ea.length-2]||c.origin;if(t(fa)&&u(ga)){return q(ga);}else return q(fa);},w=function(ea){try{return JSON.parse(ea);}catch(fa){m(fa.message);return null;}},x=function(ea,fa,ga){if(!ea.iframe){var ha=ga.createElement('iframe');ha.src=d+'/audiencenetwork/iframe/';ha.style.display='none';j(ga.body).appendChild(ha);ea.iframe=ha;ea.iframeAppendedTime=l();ea.iframeData={};}fa.iframe=j(ea.iframe);fa.iframeData=ea.iframeData;fa.tagJsIframeAppendedTime=ea.iframeAppendedTime||0;},y=function(ea){var fa=d+'/audiencenetwork/xhr/?sdk=5.5.web';for(var ga in ea)if(typeof ea[ga]!=='function')fa+='&'+ga+'='+encodeURIComponent(ea[ga]);var ha=new XMLHttpRequest();ha.open('GET',fa,true);ha.withCredentials=true;ha.onreadystatechange=function(){if(ha.readyState===4){var ia=w(ha.response);if(ia)ea.events.push({name:'xhrLoaded',source:ea.iframe.contentWindow,data:ia,postMessageTimestamp:l(),receivedTimestamp:l()});}};ha.send();},z=function(ea,fa){var ga=d+'/audiencenetwork/xhriframe/?sdk=5.5.web';for(var ha in fa)if(typeof fa[ha]!=='function')ga+='&'+ha+'='+encodeURIComponent(fa[ha]);var ia=b.createElement('iframe');ia.src=ga;ia.style.display='none';j(b.body).appendChild(ia);fa.iframe=ia;fa.iframeData={};fa.tagJsIframeAppendedTime=l();},aa=function(ea){var fa=function(event){try{var ia=event.data;if(ia.name in f)ea.events.push({name:ia.name,source:event.source,data:ia.data});}catch(ha){}},ga=j(ea.iframe).contentWindow.parent;ga.addEventListener('message',fa,false);},ba=function(ea){if(ea.context)return true;try{return !!JSON.parse(decodeURI(ea.name)).ampcontextVersion;}catch(fa){return false;}},ca=function(ea){var fa=l(),ga=p(),ha=k(n().parentElement),ia=ga!=a.top,ja=ga.$sf&&ga.$sf.ext,ka=r(ga);ga.ADNW=ga.ADNW||{};ga.ADNW.v55=ga.ADNW.v55||{ads:[]};var la=ga.ADNW.v55;s(la,ga.document);var ma={amp:ba(ga),events:[],tagJsInitTime:fa,rootElement:ha,iframe:null,tagJsIframeAppendedTime:la.iframeAppendedTime||0,url:ka,domain:v(),channel:q(r(a)),width:screen.width,height:screen.height,pixelratio:a.devicePixelRatio,placementindex:la.ads.length,crossdomain:ia,safeframe:!!ja,placementid:h.placementid,format:h.format||'300x250',testmode:!!h.testmode,onAdLoaded:h.onAdLoaded,onAdError:h.onAdError};if(h.bidid)ma.bidid=h.bidid;if(ia){z(la,ma);}else{x(la,ma,ga.document);y(ma);}aa(ma);ma.rootElement.dataset.placementid=ma.placementid;la.ads.push(ma);};try{ca();}catch(da){m(da.message||da);throw da;}})(window,document,location);
            </script>
          </div>`;

      default:
        //throw new Exception ('Unsupported tag version ' + tagVersion);
        utils.logError('Unsupported tag version ' + tagVersion);
    }
  };

  // Export the callBids function, so that prebid.js can execute this function
  // when the page asks to send out anBid requests.
  return {
    callBids: _callBids
  };
};

module.exports = AudienceNetworkAdapter;
