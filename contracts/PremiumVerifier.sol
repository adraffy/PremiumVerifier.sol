// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RLPReader, ContentLengthMismatch} from "@optimism/src/libraries/rlp/RLPReader.sol";
import {SecureMerkleTrie} from "@optimism/src/libraries/trie/SecureMerkleTrie.sol";
import {IPriceOracle} from "@ensdomains/contracts/ethregistrar/IPriceOracle.sol";

contract PremiumVerifier {
    bytes32 constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;

    uint256 constant SLOT_ethRegistrar_owners = 5;
    uint256 constant SLOT_ethRegistrar_expiries = 9;
    uint256 constant SLOT_nameWrapper_tokens = 1;

    struct OwnerProof {
        bytes ethRegistrar_storageProof; // _tokenOwners[]
        bytes nameWrapper_accountProof;
        bytes nameWrapper_storageProof; // _tokens[]
    }

    struct ExpiryProof {
        bytes ethRegistrar_accountProof;
        bytes ethRegistrar_storageProof; // expiries[]
    }

    struct Proof {
        uint256 blockNumber;
        bytes32 labelHash;
        bytes blockHeader;
        bytes blockHeader0;
        ExpiryProof expiry;
        ExpiryProof expiry0;
        OwnerProof owner0;
    }

    address immutable ethRegistrar;
    address immutable nameWrapper;
    IPriceOracle immutable priceOracle;
    constructor(
        address _ethRegistrar,
        address _nameWrapper,
        IPriceOracle _priceOracle
    ) {
        ethRegistrar = _ethRegistrar;
        nameWrapper = _nameWrapper;
        priceOracle = _priceOracle;
    }

    function verifyPremiumPurchase(
        bytes calldata vProof
    ) external view returns (address owner0, uint256 premium) {
        Proof memory proof = abi.decode(vProof, (Proof));
        bytes32 blockHash = blockhash(proof.blockNumber);
        if (blockHash == bytes32(0)) {
            blockHash = requireEIP2935BlockHash(proof.blockNumber);
        }
        require(blockHash == keccak256(proof.blockHeader), "block");
        RLPReader.RLPItem[] memory blockHeader = RLPReader.readList(
            proof.blockHeader
        );

        bytes32 blockHash0 = strictBytes32FromRLP(blockHeader[0]);
        require(blockHash0 == keccak256(proof.blockHeader0), "block0");
        RLPReader.RLPItem[] memory blockHeader0 = RLPReader.readList(
            proof.blockHeader0
        );

        bytes32 stateRoot0 = strictBytes32FromRLP(blockHeader0[3]);

        (bytes32 storageRoot0, uint256 expiry0) = determineExpiry(
            proof.labelHash,
            stateRoot0,
            proof.expiry0
        );

        require(
            expiry0 < uint256(bytes32FromRLP(blockHeader0[11])), // prev timestamp
            "exp0 after block0"
        );

        (, uint256 expiry) = determineExpiry(
            proof.labelHash,
            strictBytes32FromRLP(blockHeader[3]), // stateRoot
            proof.expiry
        );
        require(expiry > expiry0, "exp0 after exp");

        owner0 = determineOwner(
            proof.labelHash,
            stateRoot0,
            storageRoot0,
            proof.owner0
        );
        require(owner0 != address(0), "no owner");

        IPriceOracle.Price memory price = priceOracle.price(
            "",
            expiry0 +
                block.timestamp -
                uint256(bytes32FromRLP(blockHeader[11])),
            0
        );
        require(price.premium > 0, "no premium");
        premium = price.premium;
    }

    function determineExpiry(
        bytes32 labelHash,
        bytes32 stateRoot,
        ExpiryProof memory proof
    ) internal view returns (bytes32 storageRoot, uint256 expiry) {
        storageRoot = requireAccountState(
            stateRoot,
            ethRegistrar,
            proof.ethRegistrar_accountProof
        );
        expiry = uint256(
            requireStorageValue(
                storageRoot,
                followSlot(
                    SLOT_ethRegistrar_expiries,
                    abi.encodePacked(labelHash)
                ),
                proof.ethRegistrar_storageProof
            )
        );
    }

    function determineOwner(
        bytes32 labelHash,
        bytes32 stateRoot,
        bytes32 storageRoot,
        OwnerProof memory proof
    ) internal view returns (address owner) {
        owner = addressFrom(
            requireStorageValue(
                storageRoot,
                followSlot(
                    SLOT_ethRegistrar_owners,
                    abi.encodePacked(labelHash)
                ),
                proof.ethRegistrar_storageProof
            )
        );
        if (owner == nameWrapper) {
            storageRoot = requireAccountState(
                stateRoot,
                nameWrapper,
                proof.nameWrapper_accountProof
            );
            bytes32 node = keccak256(abi.encodePacked(ETH_NODE, labelHash));
            owner = addressFrom(
                requireStorageValue(
                    storageRoot,
                    followSlot(SLOT_nameWrapper_tokens, abi.encodePacked(node)),
                    proof.nameWrapper_storageProof
                )
            );
        }
    }

    /// @dev https://eips.ethereum.org/EIPS/eip-2935
    function requireEIP2935BlockHash(
        uint256 blockNumber
    ) internal view returns (bytes32 blockHash) {
        bool ok;
        assembly {
            mstore(0, blockNumber)
            ok := staticcall(
                5000, // gas
                0x0000F90827F1C53a10cb7A02335B175320002935,
                0,
                32,
                0,
                32
            )
            blockHash := mload(0)
        }
        require(ok);
    }

    function requireAccountState(
        bytes32 stateRoot,
        address target,
        bytes memory proof
    ) internal pure returns (bytes32) {
        bytes memory encodedState = SecureMerkleTrie.get(
            abi.encodePacked(target),
            abi.decode(proof, (bytes[])),
            stateRoot
        );
        RLPReader.RLPItem[] memory v = RLPReader.readList(encodedState);
        return strictBytes32FromRLP(v[2]);
    }

    function requireStorageValue(
        bytes32 storageRoot,
        uint256 slot,
        bytes memory proof
    ) internal pure returns (bytes32) {
        bytes memory v = SecureMerkleTrie.get(
            abi.encodePacked(slot),
            abi.decode(proof, (bytes[])),
            storageRoot
        );
        return bytes32FromRLP(RLPReader.readBytes(v));
    }

    function strictBytes32FromRLP(
        RLPReader.RLPItem memory item
    ) internal pure returns (bytes32) {
        bytes memory v = RLPReader.readBytes(item);
        if (v.length != 32) revert ContentLengthMismatch();
        return bytes32(v);
    }

    function bytes32FromRLP(
        RLPReader.RLPItem memory item
    ) internal pure returns (bytes32) {
        return bytes32FromRLP(RLPReader.readBytes(item));
    }

    function bytes32FromRLP(bytes memory v) internal pure returns (bytes32) {
        if (v.length > 32) revert ContentLengthMismatch();
        return bytes32(v) >> ((32 - v.length) << 3);
    }

    function addressFrom(bytes32 x) internal pure returns (address) {
        return address(uint160(uint256(x)));
    }

    function followSlot(
        uint256 slot,
        bytes memory key
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(key, slot)));
    }
}
