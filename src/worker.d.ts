declare module "*?worker&inline" {
  const InlineWorker: new () => Worker;
  export default InlineWorker;
}
