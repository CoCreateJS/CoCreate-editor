module.exports = {
	organization_id: "",
	key: "",
	host: "",
	sources: [
		{
			array: "files",
			object: {
				name: "index.html",
				path: "/docs/editor",
				pathname: "/docs/editor/index.html",
				src: "{{./docs/index.html}}",
				host: ["*"],
				directory: "editor",
				"content-type": "{{content-type}}",
				public: "true"
			}
		}
	]
};
