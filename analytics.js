/* ============================================
   LOSTimer — analytics.js  v1.0.0
   The ONLY place the GA measurement ID lives.
   Loaded with: <script async src="analytics.js"></script>
   ============================================ */
(function () {
  'use strict';

  var GA_ID = 'G-T2FT3Z20PX';

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', GA_ID);
})();
