// RoadScanAI model source fix: use a GitHub-hosted ONNX file with CORS support.
// The previous Hugging Face/Xet downloads could fail in mobile browsers.
(function(){
  const nativeFetch = window.fetch.bind(window);
  const stableModel = 'https://raw.githubusercontent.com/Prince-IISc-CalUniv/Edge-AI-Traffic-Analytics-and-violation-Detection/main/pipelines/pipeline3_pothole_detection/best.onnx';
  window.fetch = function(input, init){
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if(url.includes('huggingface.co/') && url.includes('best.onnx')) return nativeFetch(stableModel, init);
    return nativeFetch(input, init);
  };
})();
