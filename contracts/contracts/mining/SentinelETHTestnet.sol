// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract SentinelETHTestnet is ERC721A, Ownable {
    uint256 public constant MAX_URI_LENGTH = 256;

    uint256 public immutable maxSupply;
    string public contractURI;

    mapping(uint256 => string) private _tokenURIs;

    error InvalidMaxSupply();
    error InvalidQty();
    error MaxSupplyExceeded();
    error UriCountMismatch();
    error UriEmpty();
    error UriTooLong();
    error ZeroAddress();

    event TokenURIsSet(uint256 indexed startTokenId, uint256 qty);
    event ContractURIUpdated(string uri);

    constructor(uint256 initialMaxSupply, string memory initialContractURI)
        ERC721A("SentinelETH", "SETH")
        Ownable(msg.sender)
    {
        if (initialMaxSupply == 0 || initialMaxSupply > 1_000) revert InvalidMaxSupply();
        maxSupply = initialMaxSupply;
        contractURI = initialContractURI;
    }

    function mintBatch(address to, string[] calldata uris) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 count = uris.length;
        if (count == 0) revert InvalidQty();
        if (_totalMinted() + count > maxSupply) revert MaxSupplyExceeded();

        uint256 startTokenId = _nextTokenId();
        for (uint256 index = 0; index < count; ++index) {
            string calldata uri = uris[index];
            if (bytes(uri).length == 0) revert UriEmpty();
            if (bytes(uri).length > MAX_URI_LENGTH) revert UriTooLong();
            _tokenURIs[startTokenId + index] = uri;
        }

        _safeMint(to, count);
        emit TokenURIsSet(startTokenId, count);
    }

    function setContractURI(string calldata uri) external onlyOwner {
        contractURI = uri;
        emit ContractURIUpdated(uri);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        return _tokenURIs[tokenId];
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }
}