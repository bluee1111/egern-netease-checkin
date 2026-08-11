export default async function (ctx) {
  try {
    ctx.notify({
      title: "网易云模块诊断",
      body: "模块脚本和系统通知正常。若打开网易云仍不提示 Cookie，说明 App 流量未经过 MITM。",
      sound: true,
      duration: 6,
    });
  } catch (error) {
    console.log(`网易云诊断异常：${error.message || error}`);
  }
}
