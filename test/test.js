import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import { Foundry } from "@adraffy/blocksmith";
import { ABI_CODER } from "@unruggable/gateways";
import { generateProof } from "../src/prover.js";

const label = "raffy";
const ONE_DAY = 86400;
const ONE_YEAR = 365 * ONE_DAY;

const foundry = await Foundry.launch({ infoLog: true });
try {
	const ensRegistry = await foundry.deploy({
		import: "@ensdomains/contracts/registry/ENSRegistry.sol",
	});

	const ethRegistrar = await foundry.deploy({
		bytecode: ethers.concat([
			await readFile(
				new URL("./ethRegistrarCode.txt", import.meta.url),
				"utf8"
			),
			ABI_CODER.encode(
				["address", "bytes32"],
				[ensRegistry.target, ethers.namehash("eth")]
			),
		]),
		abi: [
			`function GRACE_PERIOD() view returns (uint256)`,
			`function available(uint256 id) view returns (bool)`,
			`function ownerOf(uint256 id) view returns (address)`,
			`function addController(address controller)`,
			`function register(uint256 id, address owner, uint256 duration) payable`,
		],
	});

	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.ZeroHash,
			ethers.id("eth"),
			ethRegistrar,
			ethers.ZeroAddress,
			0
		)
	);

	const reverseRegistrar = await foundry.deploy({
		import: "@ensdomains/contracts/reverseRegistrar/ReverseRegistrar.sol",
		args: [ensRegistry],
	});

	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.ZeroHash,
			ethers.id("reverse"),
			foundry.wallets.admin.address,
			ethers.ZeroAddress,
			0
		)
	);

	await foundry.confirm(
		ensRegistry.setSubnodeRecord(
			ethers.namehash("reverse"),
			ethers.id("addr"),
			reverseRegistrar,
			ethers.ZeroAddress,
			0
		)
	);

	const fakeNameResolver = await foundry.deploy(`contract FakeNameResolver {
		function setName(bytes32 node, string calldata name) external {
			// do nothing
		}
	}`);

	await foundry.confirm(
		reverseRegistrar.setDefaultResolver(fakeNameResolver)
	);

	const nameWrapper = await foundry.deploy({
		import: "@ensdomains/contracts/wrapper/NameWrapper.sol",
		args: [ensRegistry, ethRegistrar, ethers.ZeroAddress],
	});

	const ethPrice = 4000;
	const fakeUSDOracle = await foundry.deploy(`contract FakeUSDOracle {
		function latestAnswer() external view returns (int256) {
			return ${Math.round(ethPrice)} * 1e8;
		}
	}`);

	const priceOracle = await foundry.deploy({
		import: "@ensdomains/contracts/ethregistrar/ExponentialPremiumPriceOracle.sol",
		args: [
			fakeUSDOracle,
			[0n, 0n, 20294266869609n, 5073566717402n, 158548959919n], // $/sec for 720, 160, 5
			100000000000000000000000000n, // 100m$
			21, // days
		],
	});

	const wrappedController = await foundry.deploy({
		import: "@ensdomains/contracts/ethregistrar/ETHRegistrarController.sol",
		args: [
			ethRegistrar,
			priceOracle,
			0, // min commit (bypassed)
			1, // max commit
			reverseRegistrar,
			nameWrapper,
			ensRegistry,
		],
	});

	await foundry.confirm(ethRegistrar.addController(wrappedController));
	await foundry.confirm(ethRegistrar.addController(foundry.wallets.admin));

	const verifier = await foundry.deploy({
		file: "PremiumVerifier",
		args: [ethRegistrar, nameWrapper, priceOracle],
	});

	// register
	await foundry.confirm(
		ethRegistrar.register(
			ethers.id(label),
			foundry.wallets.admin.address,
			1n
		)
	);

	// wait for name to go into premium
	const GRACE_PERIOD = BigInt(await ethRegistrar.GRACE_PERIOD());
	await foundry.nextBlock({ sec: GRACE_PERIOD + BigInt(15 * ONE_DAY) }); // 0-21 days

	// check in premium
	await assert.rejects(() => ethRegistrar.ownerOf(ethers.id(label)));
	assert(await ethRegistrar.available(ethers.id(label)));
	assert(await wrappedController.available(label));

	// check price
	const { premium } = await wrappedController.rentPrice(label, ONE_YEAR);
	assert(premium > 0);

	// register again
	const receipt = await foundry.confirm(
		ethRegistrar.register(
			ethers.id(label),
			foundry.wallets.admin.address,
			ONE_YEAR
		)
	);

	// wait a bit
	await foundry.nextBlock({ sec: 300 });

	const proof = await generateProof(
		foundry.provider,
		BigInt(receipt.blockNumber),
		ethers.id(label),
		{
			ethRegistrar: ethRegistrar.target,
			nameWrapper: nameWrapper.target,
		}
	);

	const gas = await verifier.provePremiumPurchase.estimateGas(proof);
	const [owner0, premium2] = await verifier.provePremiumPurchase(proof);

	console.log({ gas, owner0, premium, premium2 });

	// TODO: wrapped example
	// TODO: prove tx inclusion?
} finally {
	await foundry.shutdown();
}
