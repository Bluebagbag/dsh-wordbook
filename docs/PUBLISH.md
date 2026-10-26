# 发布到 GitHub

## 1. 注册 GitHub

1. 打开 <https://github.com/signup>
2. 填邮箱、密码、用户名（用户名会出现在仓库地址里，想好再定）
3. 完成邮箱验证码 / 人机验证
4. 登录后右上角头像 → Settings → Emails，确认邮箱已验证

> 这一步必须你本人做：要邮箱验证码和人机验证，我不能替你注册或登录。

## 2. 建一个空仓库

1. 右上角 `+` → **New repository**
2. Repository name：`dsh-wordbook`
3. 选 **Public**（想私有也行，Private）
4. **不要**勾选 Add a README / .gitignore / license（本地已经有了）
5. Create repository

建完页面会显示仓库地址，例如：

```
https://github.com/你的用户名/dsh-wordbook.git
```

把这个地址发我，或者自己按下面步骤推。

## 3. 用 SSH 推送（推荐，不需要把密码给我）

如果你没有 SSH key，先生成一把（有就跳过）：

```bash
ssh-keygen -t ed25519 -C "你的邮箱"
cat ~/.ssh/id_ed25519.pub
```

把 `cat` 出来的整行公钥复制下来。

2. GitHub → 右上角头像 → **Settings** → **SSH and GPG keys** → **New SSH key**；
3. Title 填 `dsh-wordbook`，Key type 选 `Authentication Key`，粘贴公钥，保存；
4. 回到这里执行：

```bash
cd /sdcard/dsh/dsh-wordbook
git remote add origin git@github.com:你的用户名/dsh-wordbook.git
git branch -M main
git push -u origin main
```

如果 `git` 报 host key 确认，输入 `yes`。

## 4. 手机上用网页上传（没有电脑时）

GitHub 网页版支持 `Add file → Upload files`，但手机上选文件夹不一定好用。两条路：

- **有电脑**：把 `dsh-wordbook-repo.zip` 拷到电脑解压，打开仓库页面 → Add file → Upload files，把解压后的文件夹内容拖进去，Commit。
- **只有手机**：用 Termux 或本容器里的 git（先 `pkg install git openssh` 或 `apt-get install git openssh-client`），按上面的 SSH 步骤推。

## 5. 仓库里不要放什么

- 不要提交 `$DSH_HOME/maimemo/config.json`（里面是 token）；
- 不要提交 `node_modules/`、日志、`.bak`；
- `.gitignore` 已经挡掉了这些。

## 6. 推送后建议

- 在仓库 Settings → General → Description 填一句简介；
- 加 Topics：`dsh-plugin`、`deepseek-harness`、`vocabulary`、`maimemo`；
- 在 Releases 里把 `dsh-wordbook-repo.zip` 作为附件上传，方便别人下载。
