/**
 * This file is licensed under the MIT License.
 * 
 * Some code taken from https://github.com/actions/upload-release-asset
 */

const core = require("@actions/core");
const { GitHub } = require("@actions/github");
const fs = require("fs");


async function listAssetsSortedByDate(github, owner, repo) {
	core.info("Listing assets");

	const releaseId = core.getInput("release_id", { required: true });

	let assets = await github.repos.listAssetsForRelease({
		owner: owner,
		repo: repo,
		release_id: parseInt(releaseId),
		per_page: 100
	});

	assets.data.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

	return assets;
}

function findToBeDeletedAssets(assets, assetName, commitHash) {
	core.info("Looking for old assets that can be deleted");

	const maxReleases = parseInt(core.getInput("max_releases", { required: false }));
	let assetsNamesRegex = core.getInput("assets_names_regex", { required: false });
	var regExp = assetsNamesRegex && new RegExp(assetsNamesRegex);
	core.info("Created RegExp");
	core.info(assetsNamesRegex);
	core.info(regExp);

	const placeholderStart = assetName.indexOf("$$");
	const nameStart = assetName.substr(0, placeholderStart);
	const nameEnd = assetName.substr(placeholderStart + 2);

	let filteredAssets = {
		toBeDeletedAssetsIds: [],
		existingAssetNameId: undefined,
		isCurrentCommitAlreadyReleased: false
	};

	let numFound = 0;
	for (let i = 0; i < assets.data.length; i++) {
		const asset = assets.data[i];
		core.info("Processing asset.name: " + asset.name);
		if (asset.name == assetName) {
			// Not allowed to upload already existing name of asset (not commit hash or date in filename)
			filteredAssets.existingAssetNameId = asset.id;
		} else if (regExp && regExp.test(asset.name)) {
			numFound++;
			if (numFound >= maxReleases) {
				core.info("Queuing old asset " + asset.name + " for deletion (found by RegExp)");
				filteredAssets.toBeDeletedAssetsIds.push(asset.id);
			}
		} else if (asset.name.startsWith(nameStart) && asset.name.endsWith(nameEnd)) {
			if (asset.name.endsWith("-" + commitHash + nameEnd)) {
				filteredAssets.isCurrentCommitAlreadyReleased = true;
				break;
			} else {
				numFound++;
				if (numFound >= maxReleases) {
					core.info("Queuing old asset " + asset.name + " for deletion (found by splitting assetName)");
					filteredAssets.toBeDeletedAssetsIds.push(asset.id);
				}
			}
		}
	}

	return filteredAssets;
}

async function deleteOldAssets(github, owner, repo, toBeDeletedAssetsIds) {
	core.info("Deleting " + toBeDeletedAssetsIds.length + " old assets");

	for (let i = 0; i < toBeDeletedAssetsIds.length; i++) {
		const id = toBeDeletedAssetsIds[i];

		await github.repos.deleteReleaseAsset({
			owner: owner,
			repo: repo,
			asset_id: id
		});
	}
}

async function uploadAsset(github, assetName) {
	core.info("Uploading asset as file " + assetName);

	const url = core.getInput("upload_url", { required: true });
	const assetPath = core.getInput("asset_path", { required: true });
	const contentType = core.getInput("asset_content_type", { required: true });

	const contentLength = filePath => fs.statSync(filePath).size;

	const headers = { 'content-type': contentType, 'content-length': contentLength(assetPath) };

	const uploadAssetResponse = await github.repos.uploadReleaseAsset({
		url,
		headers,
		name: assetName,
		file: fs.readFileSync(assetPath)
	});

	return uploadAssetResponse.data.browser_download_url;
}

function createDate() {
	let now = new Date();
	let date = now.getUTCFullYear().toString() + pad2((now.getUTCMonth() + 1).toString()) + pad2(now.getUTCDate().toString());
	return date;
}

function expandAssetName(assetName, commitHash) {
	const date = createDate();
	const expandedAssetName = assetName.replace("$$", date + "-" + commitHash);
	return expandedAssetName;
}

function pad2(v) {
	v = v.toString();
	while (v.length < 2) v = "0" + v;
	return v;
}

async function run() {
	try {
		let assetName = core.getInput("asset_name", { required: true });

		const github = new GitHub(process.env.GITHUB_TOKEN);
		const commitHash = process.env.GITHUB_SHA.substr(0, 6);
		const repository = process.env.GITHUB_REPOSITORY.split('/');
		const owner = repository[0];
		const repo = repository[1];

		core.info("Checking previous assets");

		let assets = await listAssetsSortedByDate(github, owner, repo);
		let filteredAssets = findToBeDeletedAssets(assets, assetName, commitHash);

		if (filteredAssets.isCurrentCommitAlreadyReleased) {
			core.info("Current commit already released, exiting");
			core.setOutput("uploaded", "no");
			return;
		}

		if (filteredAssets.existingAssetNameId) {
			core.info("Deleting old asset of the same name at first");
			await github.repos.deleteReleaseAsset({
				owner: owner,
				repo: repo,
				asset_id: filteredAssets.existingAssetNameId
			});
		}

		const expandedAssetName = expandAssetName(assetName, commitHash);
		let url = await uploadAsset(github, expandedAssetName);

		await deleteOldAssets(github, owner, repo, filteredAssets.toBeDeletedAssetsIds);

		core.setOutput("uploaded", "yes");
		core.setOutput("url", url);
	} catch (error) {
		core.setFailed(error.message);
	}
}


run();
